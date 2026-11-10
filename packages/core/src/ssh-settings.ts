/** Public connection preferences, never credentials. No transport dependencies. */
export interface SshConnectionSettings {
  version: 1;
  authOrder?: Array<'private-key' | 'password' | 'keyboard-interactive'>;
  timeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  proxy?: { enabled: boolean; protocol: 'http' | 'https' | 'socks5'; address: string; port: number; username?: string };
  algorithms?: { hostKey?: string[]; cipher?: string[]; kex?: string[] };
  terminal?: { encoding?: 'utf8' | 'gb18030' | 'gbk' | 'big5' | 'shift_jis' | 'windows-1252' | 'latin1'; term?: string };
  files?: { watch?: boolean; followCwd?: boolean };
  x11?: { enabled: boolean; display: number; screen: number; cookie: 'auto' | 'manual' | 'none' };
  session?: { directory?: string; initialization?: string; keepaliveCommand?: string; keepaliveIntervalMs?: number;
    environment?: Array<{ name: string; value: string }> };
}

export interface SshCredentials { password?: string; passphrase?: string; proxyPassword?: string; x11Cookie?: string }
