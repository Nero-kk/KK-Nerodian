import { getLanguage } from 'obsidian';

const ko = {
  open: '원격 채팅 열기', settings: '원격 연결 설정', endpoint: '브리지 HTTPS 주소', token: '접속 토큰',
  provider: '제공자', model: '모델', defaultModel: '서버 기본 모델', you: '나',
  searchSessions: '제목 또는 세션 ID로 검색', noSessions: '일치하는 대화가 없습니다.',
  tokenHint: '토큰은 이 기기의 Obsidian 비밀 저장소에 저장됩니다.', save: '연결 설정 저장', saved: '연결 설정을 저장했습니다.',
  test: '연결 검사', ready: '연결됨', offline: '연결되지 않음', connecting: '연결 중…', running: '응답 중…',
  newSession: '새 대화', sessions: '대화 선택', reconnect: '다시 연결', send: '보내기', stop: '중지',
  placeholder: '원격 에이전트에게 메시지 보내기', empty: '원격 연결 설정에서 브리지 주소와 토큰을 저장한 뒤 연결하세요.',
  allow: '허용', deny: '거부', approval: '도구 실행 승인', message: '메시지', error: '오류',
  description: '휴대폰과 서버가 같은 Tailscale 네트워크에 연결되어 있어야 합니다. 서버 작업 폴더의 파일을 사용하며, 볼트를 자동 동기화하지 않습니다.',
  noSecretStorage: '이 기기에서 비밀 저장소를 사용할 수 없습니다.',
} as const;

const en: Record<keyof typeof ko, string> = {
  open: 'Open remote chat', settings: 'Remote connection settings', endpoint: 'Bridge HTTPS URL', token: 'Access token',
  provider: 'Provider', model: 'Model', defaultModel: 'Server default model', you: 'You',
  searchSessions: 'Search by title or session ID', noSessions: 'No matching conversations.',
  tokenHint: 'The token is saved in Obsidian secret storage on this device.', save: 'Save connection', saved: 'Connection saved.',
  test: 'Test connection', ready: 'Connected', offline: 'Disconnected', connecting: 'Connecting…', running: 'Responding…',
  newSession: 'New conversation', sessions: 'Choose conversation', reconnect: 'Reconnect', send: 'Send', stop: 'Stop',
  placeholder: 'Message the remote agent', empty: 'Save the bridge URL and access token in remote connection settings, then connect.',
  allow: 'Allow', deny: 'Deny', approval: 'Tool approval', message: 'Message', error: 'Error',
  description: 'Connect this device and the server to the same Tailscale network. Files are read from the server workspace; the vault is not synced automatically.',
  noSecretStorage: 'Secret storage is unavailable on this device.',
};

export function t(key: keyof typeof ko): string {
  const language = getLanguage();
  return (language.startsWith('ko') ? ko : en)[key];
}
