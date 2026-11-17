import { DEFAULT_SSH_CONNECTION, SSHConnectionError } from '@/shared/ssh/SSHConnection';
import { exportSSHProfile, importSSHProfile } from '@/shared/ssh/SSHConnectionProfile';

it.each(['claude', 'codex'] as const)('round-trips %s SSH settings without other provider data or credentials', provider => {
  const connection = { ...DEFAULT_SSH_CONNECTION, enabled: true, host: 'user@remote', port: 2202, remoteDirectory: '/srv/vault', cliPath: `/opt/bin/${provider}`, identityFile: 'C:\\Keys\\id_ed25519' };
  const json = exportSSHProfile(provider, connection);
  expect(importSSHProfile(json, provider, DEFAULT_SSH_CONNECTION)).toEqual(connection);
  expect(() => importSSHProfile(json, provider === 'codex' ? 'claude' : 'codex', DEFAULT_SSH_CONNECTION)).toThrow(SSHConnectionError);
});

it.each(['{', '{"format":"other","version":1}', '{"format":"kk-nerodian/ssh","version":2}', JSON.stringify({ format: 'kk-nerodian/ssh', version: 1, provider: 'codex', connection: { ...DEFAULT_SSH_CONNECTION, port: 70000 } })])('rejects invalid connection profiles: %s', json => {
  expect(() => importSSHProfile(json, 'codex', DEFAULT_SSH_CONNECTION)).toThrow(SSHConnectionError);
});
