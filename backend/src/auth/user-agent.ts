/** Navegadores, na ordem de conferência (Edge e Opera também dizem "Chrome"; Chrome também diz "Safari"). */
const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\/|\bChrom(e|ium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
  // App mobile (React Native/Expo): okhttp no Android, CFNetwork/Darwin no iOS
  [/\bokhttp\/|\bExpo\b|\bCFNetwork\/|\bDarwin\//i, 'Aplicativo'],
];

/** Sistemas, na ordem de conferência (iPhone e iPad também dizem "Mac OS X"). */
const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/\bWindows\b/, 'Windows'],
  [/\biPhone|\biPad|\biPod|\bCFNetwork\/|\bDarwin\//, 'iOS'],
  [/\bAndroid\b|\bokhttp\//i, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMacintosh\b|\bMac OS X\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

export const UNKNOWN_BROWSER = 'Navegador desconhecido';

/**
 * Resumo legível do navegador de uma sessão (GET /auth/sessions): "Chrome no Windows", "Safari no iOS",
 * "Aplicativo no Android". O texto completo (User-Agent) nunca sai na resposta.
 */
export function summarizeUserAgent(
  userAgent: string | null | undefined,
): string {
  const agent = userAgent?.trim();
  if (!agent) return UNKNOWN_BROWSER;
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
  if (browser && system) return `${browser} no ${system}`;
  if (browser) return browser;
  return system ? `Navegador no ${system}` : UNKNOWN_BROWSER;
}
