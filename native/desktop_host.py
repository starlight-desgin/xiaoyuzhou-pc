"""Packaged native helper; no Chrome registration or global Python is required."""
import os
import re
from pathlib import Path
import native_host as host

RUNTIME = Path(os.environ['XYZ_DESKTOP_DATA']) / 'native'
RUNTIME.mkdir(parents=True, exist_ok=True)
host.RUNTIME_DIR = RUNTIME
host.CREDENTIALS_PATH = RUNTIME / 'asr_credentials.json'
host.WINDOWS_CREDENTIALS_PATH = RUNTIME / 'credentials.dpapi.json'
host.LOCAL_ASR_PYTHON = RUNTIME / 'local-asr-venv' / 'Scripts' / 'python.exe'
host.LOCAL_ASR_WORKER = Path(__file__).resolve().parent / 'local_asr_worker.py'


def credential_account(model_id):
    value = str(model_id or '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,160}', value):
        raise ValueError('模型 ID 无效')
    return 'desktop.model.' + value


def model_key(message):
    supplied = str(message.get('apiKey') or '').strip()
    if supplied:
        return supplied
    if message.get('credentialId'):
        value = host.keychain_get(credential_account(message['credentialId']))
        if value:
            return value
    return host.summary_api_key(host.load_credentials(), message.get('provider', 'qwen'))


def handle(message):
    action = message.get('action')
    if action == 'save_summary_model_credential':
        account = credential_account(message.get('modelId'))
        if message.get('clear'):
            host.keychain_delete(account)
        elif str(message.get('apiKey') or '').strip():
            host.keychain_set(account, message['apiKey'].strip())
        return {'configured': bool(host.keychain_get(account))}
    if action == 'get_summary_model_credential_status':
        statuses = {}
        for model in message.get('models') or []:
            model_id = model.get('id')
            configured = bool(host.keychain_get(credential_account(model_id)))
            statuses[model_id] = configured
        return {'configured': statuses}
    if action == 'test_summary_model':
        content = host.call_summary_api(
            message.get('provider'), message.get('endpoint'), message.get('model'),
            model_key(message), '请简短回复', '请回复 OK')
        return {'success': True, 'message': content, 'model': message.get('model')}
    if action == 'find_existing_transcript':
        directory = host.absolute_directory(message.get('transcriptDirectory'))
        eid = str(message.get('episodeId') or '')
        if not eid or not directory.exists():
            return {'path': ''}
        for filename in sorted(directory.glob('*.md'), key=lambda p: p.stat().st_mtime, reverse=True):
            if filename.stat().st_size <= host.SUMMARY_MAX_FILE_BYTES:
                content = filename.read_text(encoding='utf-8-sig')
                if f'/episode/{eid}' in content:
                    return {'path': str(filename)}
        return {'path': ''}
    if action == 'summarize_transcript':
        key = model_key(message)
        original = host.summary_api_key
        host.summary_api_key = lambda _credentials, _provider: key
        try:
            result = host.summarize_remote(message)
            result['modelName'] = message.get('modelName', message.get('model', ''))
            return result
        finally:
            host.summary_api_key = original
    return host.handle_message(message)


if __name__ == '__main__':
    request = host.read_message()
    if request is not None:
        try:
            host.write_message({'ok': True, 'data': handle(request)})
        except Exception as error:
            host.write_message({'ok': False, 'error': str(error)})
