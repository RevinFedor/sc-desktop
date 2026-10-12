"""Separate Boosty-only connection. Never shared settings/Voice Record key."""
import json
import os
import stat
import uuid
import hashlib
import hmac
import tempfile
from pathlib import Path


def root():
    return Path(os.environ.get('SC_DESKTOP_DIR') or Path.home() / 'Library/Application Support/sc-desktop') / 'secrets/boosty-soniox'


def put(key, *, cap_confirmed=False):
    key = key.strip()
    if not 16 <= len(key) <= 4096 or any(c.isspace() for c in key): raise ValueError('Invalid private credential input')
    directory = root(); directory.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(directory, 0o700)
    if directory.is_symlink(): raise ValueError('Private credential namespace must not be a symlink')
    identifier = str(uuid.uuid4()); file = directory / (identifier + '.json')
    data = {'version': 1, 'credential_ref': 'boosty-soniox:' + identifier, 'scope': 'boosty_only', 'provider': 'soniox',
        'key': key, 'model': 'stt-async-v5', 'language_hints': ['ru', 'en'], 'enable_speaker_diarization': True,
        'enable_language_identification': True, 'max_new_spend_usd': 20, 'auto_top_up': False,
        'provider_project_cap_confirmed': cap_confirmed}
    with file.open('x', encoding='utf-8') as stream:
        os.chmod(file, 0o600); json.dump(data, stream); stream.flush(); os.fsync(stream.fileno())
    return {k: v for k, v in data.items() if k != 'key'}


def load(reference, *, purpose='boosty_only'):
    prefix = 'boosty-soniox:'
    if not reference.startswith(prefix): raise ValueError('Only a Boosty-only credential reference is accepted')
    identifier = str(uuid.UUID(reference[len(prefix):]))
    file = root() / (identifier + '.json')
    if file.is_symlink() or stat.S_IMODE(file.stat().st_mode) & 0o077: raise ValueError('Private credential permissions invalid')
    data = json.loads(file.read_text(encoding='utf-8'))
    if data['credential_ref'] != reference or data['scope'] != 'boosty_only': raise ValueError('Credential scope mismatch')
    if purpose not in {'boosty_only', *data.get('additional_scopes', [])}:
        raise ValueError('Explicit connection release required for this purpose')
    return data


def authorize_scope(reference, purpose):
    """Extend this same private connection after explicit user authorization.

    Telegram voice shares its existing project ledger, never another budget,
    key, Voice Record setting, or implicit provider fallback.
    """
    if purpose != 'telegram_voice': raise ValueError('Unsupported additional scope')
    private = load(reference)
    if not private.get('user_ASR_model_cost_release') or not private.get('provider_project_cap_confirmed'):
        raise ValueError('Existing model/project/budget release required')
    private['additional_scopes'] = sorted(set(private.get('additional_scopes', [])) | {purpose})
    from shared.boosty_soniox import atomic
    atomic(root() / (str(uuid.UUID(reference.removeprefix('boosty-soniox:'))) + '.json'), private)
    return describe(reference)


def describe(reference):
    return {k: v for k, v in load(reference).items() if k != 'key'}


def bind_budget(reference, proof_path, prefix_length, prefix_sha256):
    """Attach observed Console budget proof to the existing private connection.

    A hashed visible key prefix binds the Console project row to the provided
    key without sending the key to the model, browser code, argv or logs.
    """
    private = load(reference)
    proof_bytes = Path(proof_path).read_bytes()
    proof = json.loads(proof_bytes)
    if not 12 <= prefix_length <= 128 or len(prefix_sha256) != 64: raise ValueError('Strong visible-prefix proof required')
    digest = hashlib.sha256(private['key'][:prefix_length].encode()).hexdigest()
    if not hmac.compare_digest(digest, prefix_sha256): raise ValueError('Console key prefix differs; do not bind another project')
    if (proof.get('credential_ref') != reference or proof.get('secret_value_present_in_artifact') is not False
        or proof.get('user_ASR_model_cost_release') is not True or proof.get('model') != 'stt-async-v5'
        or proof.get('cap_verified_after_fresh_GET') is not True or proof.get('autopay_existing_enabled') is not False
        or proof.get('project_monthly_limit_after_USD') != 20 or proof.get('budget_max_new_spend_USD') != 20):
        raise ValueError('Incomplete or incompatible budget release proof')
    project = str(uuid.UUID(proof['provider_project'])); organization = str(uuid.UUID(proof['provider_org']))
    warnings = proof.get('provider_enforcement_delay_warning') or []
    private.update(provider_project=project, provider_org=organization, provider_project_cap_confirmed=True,
        user_ASR_model_cost_release=True, budget_proof_sha256=hashlib.sha256(proof_bytes).hexdigest(),
        key_project_binding={'method': 'live_console_visible_prefix_sha256_match', 'visible_prefix_length': prefix_length,
                             'prefix_sha256': prefix_sha256}, provider_budget_usd=20, provider_autopay_enabled=False,
        provider_cap_is_absolute_guarantee=False, provider_enforcement_delay_warning=warnings)
    identifier = str(uuid.UUID(reference.removeprefix('boosty-soniox:')))
    destination = root() / (identifier + '.json')
    fd, temporary = tempfile.mkstemp(prefix='.binding-', dir=root())
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            os.fchmod(stream.fileno(), 0o600); json.dump(private, stream); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    return describe(reference)
