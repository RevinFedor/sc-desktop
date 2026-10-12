"""Short, cross-process transactions on the existing Boosty/TG Soniox ledger."""
import contextlib
import fcntl
import hashlib
import json
import os
import time
import math
from decimal import Decimal
from pathlib import Path
from shared.boosty_soniox import SonioxPending, atomic, cost


@contextlib.contextmanager
def project_transaction(path, timeout=120):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix('.lock').open('a+') as stream:
        deadline = time.monotonic() + timeout
        while True:
            try: fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB); break
            except BlockingIOError:
                if time.monotonic() >= deadline: raise SonioxPending('Existing project transaction busy; no second ledger')
                time.sleep(.05)
        try: yield
        finally: fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class SharedBudget:
    def __init__(self, path, reference, run_token):
        self.path = Path(path); self.reference = reference; self.run_token = run_token

    def read(self):
        ledger = json.loads(self.path.read_text())
        if ledger['credential_ref'] != self.reference: raise SonioxPending('Another connection owns project ledger')
        return ledger

    def update(self, change):
        with project_transaction(self.path):
            ledger = self.read(); result = change(ledger)
            ledger['revision'] = ledger.get('revision', 0) + 1; atomic(self.path, ledger)
            return result

    @staticmethod
    def totals(ledger):
        actual = sum((cost(r['cost_usd']) for r in ledger['requests'].values() if r['state'] == 'billed'), Decimal('0'))
        reserved = sum((cost(r['reservation_usd']) for r in ledger['requests'].values() if r['state'] != 'billed'), Decimal('0'))
        return actual, reserved

    def admit(self, reference, identity, receipt_path, audio_bytes, observed_total):
        duration = identity['duration_seconds']
        if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 18000:
            raise SonioxPending('Known bounded duration required')
        reservation = cost(str(duration)) / Decimal(3600) * Decimal('.30') + Decimal('.10')
        def change(ledger):
            if reference in ledger['requests']: raise SonioxPending('Existing receipt must resume, never readmit')
            if ledger.get('admission_pause'): raise SonioxPending('Current actual billing requires reconciliation')
            active = [r for r in ledger['requests'].values() if r['state'] not in {'billed', 'quarantined_unpaid_upload'}]
            if any(r.get('outcome_unknown') or r.get('active_run_token') != self.run_token for r in active):
                raise SonioxPending('Unknown/foreign paid admission retained; reconcile exact receipt')
            actual, reserved = self.totals(ledger)
            observed = cost(observed_total) - cost(ledger['baseline_cost_usd'])
            if observed < actual or observed > actual + reserved:
                raise SonioxPending('Project usage not reconciled to owned active reservations')
            cap = cost(ledger.get('max_new_spend_usd', '20')); margin = cost(ledger.get('client_safety_reserve_usd', '2'))
            if max(actual, observed) + reserved + reservation + margin > cap:
                raise SonioxPending('Budget pause: aggregate actual+all reservations+margin exceeds released cap')
            if len(active) >= ledger['parallel_policy']['workers']:
                raise SonioxPending('Shared project worker slots full')
            policy = ledger['parallel_policy']
            booked_bytes = sum(r.get('cloud_storage_reservation_bytes', 0) for r in ledger['requests'].values()
                               if not r.get('provider_file_deleted_after_current_rag'))
            if policy['initial_provider_file_bytes'] + booked_bytes + audio_bytes > policy['provider_storage_ceiling_bytes']:
                raise SonioxPending('Cloud storage admission pause; only verified completed files may be evicted')
            entry = {'state': 'reserved', 'identity': identity, 'reservation_usd': str(reservation),
                     'receipt_path': str(receipt_path), 'active_run_token': self.run_token,
                     'cloud_storage_reservation_bytes': audio_bytes, 'admitted_at': time.time()}
            ledger['requests'][reference] = entry
            receipt = {'identity': identity, 'state': 'not_submitted', 'client_reference_id': reference,
                       'active_run_token': self.run_token}
            # Crash between pair writes leaves a reservation and forbids POST.
            atomic(receipt_path, receipt)
            return entry
        return self.update(change)

    def mark(self, reference, **fields):
        def change(ledger):
            entry = ledger['requests'][reference]
            if entry.get('active_run_token') not in {None, self.run_token}:
                raise SonioxPending('Another run owns this paid receipt')
            entry.update(fields); return dict(entry)
        return self.update(change)

    def before_create(self, reference, observed_total):
        def change(ledger):
            entry = ledger['requests'][reference]
            if entry['state'] != 'uploaded' or entry.get('active_run_token') != self.run_token:
                raise SonioxPending('Exact uploaded file reservation required')
            if any(r.get('outcome_unknown') for r in ledger['requests'].values()):
                raise SonioxPending('Uncertain paid handoff blocks further creates')
            actual, reserved = self.totals(ledger)
            observed = cost(observed_total) - cost(ledger['baseline_cost_usd'])
            if observed < actual or observed > actual + reserved:
                raise SonioxPending('Provider actual usage not covered by owned reservations')
            if max(actual, observed) + reserved + cost(ledger.get('client_safety_reserve_usd', '2')) > cost(ledger.get('max_new_spend_usd', '20')):
                raise SonioxPending('Actual+inflight+margin exceeds current release')
            entry.update(state='submit_inflight', submit_started_at=time.time())
        self.update(change)

    def bill(self, reference, billing):
        def change(ledger):
            entry = ledger['requests'][reference]; charge = cost(billing['cost_usd'])
            if entry['state'] == 'billed':
                if cost(entry['cost_usd']) != charge or entry['usage_uuid'] != billing['uuid']:
                    raise SonioxPending('Actual bill changed; no replacement')
                return
            entry.update(state='billed', cost_usd=str(charge), usage_uuid=billing['uuid'], billed_at=time.time())
            actual, reserved = self.totals(ledger)
            if actual + reserved + cost(ledger.get('client_safety_reserve_usd', '2')) > cost(ledger.get('max_new_spend_usd', '20')):
                ledger['admission_pause'] = 'actual_bill_exceeded_conservative_reservation'
        self.update(change)

    def rate_limit(self, route, limit):
        """Persist admission windows; sleep OUTSIDE the project critical section."""
        deadline = time.monotonic() + 180
        while True:
            now = time.time()
            def change(ledger):
                values = [t for t in ledger.setdefault('api_rate_windows', {}).get(route, []) if t > now - 60]
                if len(values) >= limit:
                    ledger['api_rate_windows'][route] = values
                    return max(.05, values[0] + 60 - now)
                values.append(now); ledger['api_rate_windows'][route] = values; return 0
            delay = self.update(change)
            if not delay: return
            if time.monotonic() + delay > deadline: raise SonioxPending('Provider RPM admission window pending')
            time.sleep(delay)


def release_remaining(reference, remaining, proof_path):
    """Bound an explicit remaining-credit release to existing project/key proof."""
    from shared.boosty_soniox_credential import load, root, describe
    from shared.boosty_soniox import Client
    private = load(reference); raw = Path(proof_path).read_bytes(); proof = json.loads(raw)
    amount = cost(remaining)
    if not 0 < amount <= Decimal('24'): raise SonioxPending('This user release is bounded to24USD remaining')
    no_secret = proof.get('secret_value_present_in_artifact') is False or (
        proof.get('new_budget_or_key_namespace') is False and proof.get('credential_key_changed') is False
        and proof.get('Voice_Record_key_changed') is False)
    released = proof.get('budget_remaining_USD', proof.get('user_authorized_additional_spend_USD'))
    if (proof.get('credential_ref') != reference or proof.get('provider_project') != private['provider_project']
        or proof.get('provider_org') != private['provider_org'] or not no_secret
        or proof.get('cap_verified_after_fresh_GET') is not True or proof.get('autopay_existing_enabled') is not False
        or proof.get('user_ASR_model_cost_release') is not True or cost(released) != amount):
        raise SonioxPending('Fresh same-project Console cap/autopay and bounded user release proof required')
    provider_cap = cost(proof['project_monthly_limit_after_USD'])
    path = root().parents[1] / 'jobs/boosty-soniox' / private['provider_project'] / 'budget.json'
    old = json.loads(path.read_text())
    observed = cost(Client(private['key']).usage(old['window_start'])['total']['total_cost_usd'])
    proof_hash = hashlib.sha256(raw).hexdigest()
    with project_transaction(path):
        ledger = json.loads(path.read_text())
        if ledger['credential_ref'] != reference: raise SonioxPending('Same project connection required')
        if proof_hash in ledger.get('budget_releases', {}):
            return {'ok': True, 'deduplicated': True, **ledger['budget_releases'][proof_hash]}
        actual, reserved = SharedBudget.totals(ledger)
        if observed - cost(ledger['baseline_cost_usd']) != actual:
            raise SonioxPending('Actual billed usage must reconcile before renewed release')
        allowed = min(amount, provider_cap - observed)
        if allowed <= 0: raise SonioxPending('Provider monthly cap exhausted')
        maximum = actual + allowed
        release = {'actual_at_release_usd': str(actual), 'remaining_authorized_usd': str(allowed),
                   'requested_remaining_usd': str(amount),
                   'max_new_spend_usd': str(maximum), 'provider_monthly_cap_usd': str(provider_cap),
                   'risk_reservations_usd': str(reserved), 'proof_sha256': proof_hash, 'released_at': time.time()}
        private.update(provider_budget_usd=str(provider_cap), max_new_spend_usd=str(maximum),
                       budget_release_proof_sha256=proof_hash)
        atomic(root() / (reference.split(':')[1] + '.json'), private)
        ledger.update(max_new_spend_usd=str(maximum), client_safety_reserve_usd='2')
        ledger.setdefault('budget_releases', {})[proof_hash] = release; atomic(path, ledger)
    return {'ok': True, **release, 'auto_top_up': False, 'key_unchanged': True}
