"""Shared SSH connection. Credentials stay in the terminal environment."""
import argparse
import base64
import getpass
import hashlib
import os
from pathlib import Path
import posixpath
import re
import sys


def required_setting(name):
    value = os.environ.get(name, '').strip()
    if not value or not value.isprintable():
        raise ValueError(f'Set {name} in the deployment environment.')
    return value


def web_root():
    value = required_setting('AURORA_WEB_ROOT')
    if not value.startswith('/') or value.startswith('//') or '..' in value.split('/') or posixpath.normpath(value) == '/':
        raise ValueError('AURORA_WEB_ROOT must be an absolute remote website directory.')
    return posixpath.normpath(value)


def connect():
    host = required_setting('AURORA_SSH_HOST')
    user = required_setting('AURORA_SSH_USER')
    port = int(os.environ.get('AURORA_SSH_PORT', '22'))
    if not 1 <= port <= 65535:
        raise ValueError('AURORA_SSH_PORT must be between 1 and 65535.')
    fingerprint = os.environ.get('AURORA_SSH_FINGERPRINT')
    if fingerprint is not None and not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}', fingerprint):
        raise ValueError('AURORA_SSH_FINGERPRINT must be an OpenSSH SHA256 fingerprint.')

    import paramiko
    client = paramiko.SSHClient()
    try:
        if fingerprint:
            class PinnedHost(paramiko.MissingHostKeyPolicy):
                def missing_host_key(self, client, hostname, key):
                    actual = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode('ascii').rstrip('=')
                    if 'SHA256:' + actual != fingerprint:
                        raise paramiko.SSHException('SSH host fingerprint mismatch.')

            client.set_missing_host_key_policy(PinnedHost())
        else:
            client.load_system_host_keys()
            if os.name == 'nt':
                system_hosts = Path(os.environ['PROGRAMDATA']) / 'ssh' / 'ssh_known_hosts'
            else:
                system_hosts = Path('/etc/ssh/ssh_known_hosts')
            if system_hosts.is_file():
                client.load_system_host_keys(str(system_hosts))
            client.set_missing_host_key_policy(paramiko.RejectPolicy())
        password = os.environ.get('AURORA_SSH_PASSWORD')
        if not password and sys.stdin.isatty():
            password = getpass.getpass('SSH password (not saved): ')
        client.connect(host, port=port, username=user, password=password, timeout=20, auth_timeout=20)
    except Exception:
        client.close()
        raise
    return client

def execute(client, command):
    _, output, errors = client.exec_command(command, timeout=60)
    text = output.read().decode('utf-8', 'replace')
    error = errors.read().decode('utf-8', 'replace')
    code = output.channel.recv_exit_status()
    if code:
        raise RuntimeError(error or text or f'Remote command failed ({code})')
    return text

def run(commands):
    with connect() as client:
        return '\n'.join(execute(client, command) for command in commands)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('commands', nargs='+', help='Remote shell command to run')
    print(run(parser.parse_args().commands))
