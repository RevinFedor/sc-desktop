#!/usr/bin/env python3
"""Private stdin/hidden-prompt credential intake; output opaque reference only."""
import argparse
import getpass
import json
import sys
import datetime
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared.boosty_soniox_credential import put, describe, load, bind_budget, authorize_scope


def verify(reference):
    import requests
    private = load(reference)
    checks = {}
    now = datetime.datetime.now(datetime.timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat().replace('+00:00', 'Z')
    end = now.isoformat().replace('+00:00', 'Z')
    for route in ['models', 'files/count', 'transcriptions/count', 'concurrency-limits', 'usage/summary', 'usage-logs']:
        response = requests.get('https://api.soniox.com/v1/' + route,
            headers={'Authorization': 'Bearer ' + private['key']}, timeout=30, allow_redirects=False,
            params={'start_time': start, 'end_time': end, **({'limit': 1} if route == 'usage-logs' else {})} if route.startswith('usage') else None)
        checks[route] = {'http_status': response.status_code}
        if route == 'models' and response.status_code == 200:
            payload = response.json()
            models = payload if isinstance(payload, list) else payload.get('models') or payload.get('data') or []
            checks[route]['model_ids'] = [m.get('id') or m.get('name') for m in models if isinstance(m, dict)]
        elif response.status_code == 200 and route == 'concurrency-limits':
            data = response.json()
            checks[route]['scope'] = {kind: {field: data.get(kind, {}).get(field) for field in ['current', 'limits']} for kind in ['project', 'organization']}
        elif response.status_code == 200 and route == 'usage/summary':
            data = response.json()
            checks[route].update(total_cost_usd=data.get('total', {}).get('total_cost_usd'), utc_window=[start, end],
                                model_ids=[m.get('model') for m in data.get('models', [])])
        elif response.status_code == 200 and route == 'usage-logs':
            data = response.json(); checks[route].update(rows=len(data.get('usage_logs', [])), more_available=data.get('next_page_cursor') is not None)
    return {'credential_ref': reference, 'checks': checks, 'paid_requests': 0, 'provider_uploads': 0,
            'server_project_identity': 'not_exposed_by_these_endpoints', 'server_balance_and_cap': 'not_proven_by_counts_or_models',
            'provider_project_cap_confirmed': private['provider_project_cap_confirmed']}


def main():
    p = argparse.ArgumentParser(prog='sc boosty-credential')
    commands = p.add_subparsers(dest='operation', required=True)
    store = commands.add_parser('put')
    mode = store.add_mutually_exclusive_group(required=True)
    mode.add_argument('--stdin', action='store_true'); mode.add_argument('--prompt', action='store_true')
    store.add_argument('--provider-project-cap-confirmed', action='store_true', help='Operator verified Soniox project spending cap20USD/autopay policy; not inferred from balance')
    get = commands.add_parser('status'); get.add_argument('--credential-ref', required=True)
    get = commands.add_parser('verify'); get.add_argument('--credential-ref', required=True)
    bind = commands.add_parser('bind-budget'); bind.add_argument('--credential-ref', required=True)
    bind.add_argument('--proof-file', required=True); bind.add_argument('--console-prefix-length', type=int, required=True)
    bind.add_argument('--console-prefix-sha256', required=True)
    grant = commands.add_parser('authorize-scope'); grant.add_argument('--credential-ref', required=True)
    grant.add_argument('--scope', required=True, choices=['telegram_voice'])
    release = commands.add_parser('release-budget'); release.add_argument('--credential-ref', required=True)
    release.add_argument('--remaining-usd', required=True); release.add_argument('--proof-file', required=True)
    args = p.parse_args()
    try:
        if args.operation == 'release-budget':
            from shared.boosty_soniox_budget import release_remaining
            print(json.dumps(release_remaining(args.credential_ref, args.remaining_usd, args.proof_file))); return 0
        out = authorize_scope(args.credential_ref, args.scope) if args.operation == 'authorize-scope' else put(sys.stdin.read(4097) if args.stdin else getpass.getpass('Boosty-only Soniox key (hidden): '),
                  cap_confirmed=args.provider_project_cap_confirmed) if args.operation == 'put' else verify(args.credential_ref) if args.operation == 'verify' else bind_budget(args.credential_ref, args.proof_file, args.console_prefix_length, args.console_prefix_sha256) if args.operation == 'bind-budget' else describe(args.credential_ref)
        print(json.dumps({'ok': True, **out})); return 0
    except Exception:
        print(json.dumps({'ok': False, 'code': 'BOOSTY_CREDENTIAL_INTAKE_FAILED', 'secret_echoed': False})); return 1


if __name__ == '__main__': raise SystemExit(main())
