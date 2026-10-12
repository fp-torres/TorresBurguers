/**
 * Helpers exclusivos dos testes de identidade (api-identity): usuários, autenticação,
 * loja, endereços, uploads e promoções. Os helpers compartilhados (support/*) não são alterados.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { E2E } from '../../../support/env';
import { type DefaultUserKey } from '../../../support/users';
import { body, login, loginAs, uid, uniqueEmail, type Session } from '../../../support/api';

export { body, uid, uniqueEmail };
export type { Session };

export const STRONG_PASSWORD = 'SenhaForte@123';
export const STAFF_ROLES = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'] as const;
export const ALL_ROLES = [...STAFF_ROLES, 'CLIENT'] as const;
export type Role = (typeof ALL_ROLES)[number];

/** Id válido para a coluna integer, mas que não existe (rotas destrutivas nunca atingem dados reais). */
export const MISSING_ID = 2_147_483_000;
/** Id numérico fora do intervalo de uma coluna integer do PostgreSQL. */
export const OUT_OF_RANGE_ID = '99999999999';

/** Contexto HTTP próprio (para beforeAll/afterAll, onde o fixture `request` não existe). */
export function newApi(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: E2E.apiURL });
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Sessões dos usuários padrão, reaproveitadas dentro do mesmo worker. */
const defaultSessions = new Map<DefaultUserKey, Session>();
export async function sessionOf(api: APIRequestContext, key: DefaultUserKey): Promise<Session> {
  const cached = defaultSessions.get(key);
  if (cached) return cached;
  const session = await loginAs(api, key);
  defaultSessions.set(key, session);
  return session;
}

/** Mapeia o perfil para o usuário padrão correspondente. */
export const DEFAULT_KEY_BY_ROLE: Record<Role, DefaultUserKey> = {
  ADMIN: 'admin',
  EMPLOYEE: 'employee',
  KITCHEN: 'kitchen',
  COURIER: 'courier',
  CLIENT: 'client',
};

export interface TestUser extends Session {
  email: string;
  password: string;
}

export function signupPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Cliente Identidade E2E',
    email: uniqueEmail('ident'),
    password: STRONG_PASSWORD,
    phone: '21988887777',
    ...overrides,
  };
}

/** Cadastra um cliente pelo endpoint público e faz login. */
export async function newClient(
  api: APIRequestContext,
  overrides: Record<string, unknown> = {},
): Promise<TestUser> {
  const data = signupPayload(overrides);
  const res = await api.post('/users', { data });
  expect(res.status(), `cadastro de cliente: ${await res.text()}`).toBe(201);
  const session = await login(api, String(data.email), String(data.password));
  return { ...session, email: String(data.email), password: String(data.password) };
}

/**
 * Contas da equipe criadas pelos testes: vão para a lixeira no afterAll de cada arquivo
 * (entregadores temporários não poluem o modal de entregadores dos outros testadores).
 */
const trackedStaff = new Set<number>();
export function trackStaff(id: number | undefined): void {
  if (typeof id === 'number') trackedStaff.add(id);
}
export async function cleanupTrackedStaff(): Promise<void> {
  if (!trackedStaff.size) return;
  const api = await newApi();
  const admin = await sessionOf(api, 'admin');
  for (const id of trackedStaff) {
    if (id === admin.user.id) continue;
    await api.delete(`/users/${id}`, { headers: bearer(admin.token) }).catch(() => undefined);
  }
  trackedStaff.clear();
  await api.dispose();
}

/** Conta da equipe (ou outro cliente) criada pelo ADMIN padrão, já com login feito. */
export async function newUserWithRole(
  api: APIRequestContext,
  role: Role,
  overrides: Record<string, unknown> = {},
): Promise<TestUser> {
  const admin = await sessionOf(api, 'admin');
  const data = signupPayload({
    name: `Equipe ${role} E2E`,
    email: uniqueEmail(`ident-${role.toLowerCase()}`),
    role,
    ...overrides,
  });
  const res = await api.post('/users', { data, headers: bearer(admin.token) });
  expect(res.status(), `cadastro de ${role} pelo ADMIN: ${await res.text()}`).toBe(201);
  const session = await login(api, String(data.email), String(data.password));
  if (role !== 'CLIENT') trackStaff(session.user.id);
  return { ...session, email: String(data.email), password: String(data.password) };
}

/** Sessão de um ator da matriz de autorização: os perfis da equipe usam os usuários padrão. */
export async function actorSession(api: APIRequestContext, role: Role): Promise<Session> {
  return sessionOf(api, DEFAULT_KEY_BY_ROLE[role]);
}

export async function adminDelete(api: APIRequestContext, userId: number): Promise<void> {
  const admin = await sessionOf(api, 'admin');
  const res = await api.delete(`/users/${userId}`, { headers: bearer(admin.token) });
  expect(res.ok(), `exclusão do usuário ${userId}: ${await res.text()}`).toBeTruthy();
}

// ---------------------------------------------------------------------------
// Catálogo, endereços e pedidos (dados próprios para os testes de identidade)
// ---------------------------------------------------------------------------

export interface Product {
  id: number;
  name: string;
  price: number | string;
}

export async function createProduct(
  api: APIRequestContext,
  overrides: Record<string, unknown> = {},
): Promise<Product> {
  const admin = await sessionOf(api, 'admin');
  const res = await api.post('/products', {
    headers: bearer(admin.token),
    data: {
      name: `[E2E identidade] Suco ${uid('p')}`,
      description: 'Produto criado pelos testes de identidade',
      price: 12.5,
      category: 'bebidas',
      available: true,
      ...overrides,
    },
  });
  expect(res.status(), `criação de produto: ${await res.text()}`).toBe(201);
  return res.json();
}

/** Soft delete do produto criado pelo teste (mantém a vitrine limpa para os outros testadores). */
export async function retireProduct(api: APIRequestContext, productId: number): Promise<void> {
  const admin = await sessionOf(api, 'admin');
  await api.delete(`/products/${productId}`, { headers: bearer(admin.token) });
}

export const ADDRESS = {
  nickname: 'Casa',
  zipCode: '22041-001',
  street: 'Avenida Atlântica',
  number: '1500',
  complement: 'Apto 202',
  neighborhood: 'Copacabana',
  city: 'Rio de Janeiro',
  state: 'RJ',
};

export async function createAddress(
  api: APIRequestContext,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const res = await api.post('/addresses', { headers: bearer(token), data: { ...ADDRESS, ...overrides } });
  expect(res.status(), `criação de endereço: ${await res.text()}`).toBe(201);
  return res.json();
}

export async function createOrder(
  api: APIRequestContext,
  token: string,
  data: Record<string, unknown>,
): Promise<Record<string, any>> {
  const res = await api.post('/orders', { headers: bearer(token), data });
  expect(res.status(), `criação de pedido: ${await res.text()}`).toBe(201);
  return res.json();
}

/** Cancela (como ADMIN) um pedido criado pelo teste, para não poluir o quadro de pedidos. */
export async function cancelOrderAsAdmin(api: APIRequestContext, orderId: number): Promise<void> {
  const admin = await sessionOf(api, 'admin');
  await api.patch(`/orders/${orderId}/cancel`, { headers: bearer(admin.token) });
}

// ---------------------------------------------------------------------------
// Asserções
// ---------------------------------------------------------------------------

/** Lista as mensagens de um corpo de erro do Nest (message: string | string[]). */
export function messagesOf(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [String(payload)];
  const message = (payload as { message?: unknown }).message;
  if (Array.isArray(message)) return message.map(String);
  return message === undefined ? [] : [String(message)];
}

/**
 * Confere o status e o essencial do corpo de erro ({statusCode, message}).
 * O formato completo do contrato ({statusCode, message, error}) é verificado à parte por
 * expectContractErrorShape, em testes dedicados (um achado não se repete em dezenas de testes).
 */
export async function expectError(
  res: APIResponse,
  status: number,
  messageMatcher?: RegExp,
): Promise<any> {
  const payload = await body(res);
  expect(res.status(), `esperado ${status}, veio ${res.status()}: ${JSON.stringify(payload)}`).toBe(status);
  expect(payload, 'corpo de erro no formato do Nest').toMatchObject({ statusCode: status });
  expect(
    typeof payload.message === 'string' || Array.isArray(payload.message),
    `campo "message" em ${JSON.stringify(payload)}`,
  ).toBeTruthy();
  if (messageMatcher) expect(messagesOf(payload).join(' | ')).toMatch(messageMatcher);
  return payload;
}

/** Formato de erro do contrato: {statusCode, message (string | string[]), error}. */
export function expectContractErrorShape(payload: any, status: number): void {
  expect(payload, `formato de erro do contrato: ${JSON.stringify(payload)}`).toMatchObject({ statusCode: status });
  expect(typeof payload.error, `campo "error" ausente em ${JSON.stringify(payload)}`).toBe('string');
  expect(
    typeof payload.message === 'string' || Array.isArray(payload.message),
    `campo "message" em ${JSON.stringify(payload)}`,
  ).toBeTruthy();
}

/** Caminhos de chaves sensíveis (senha/hash) em qualquer nível do JSON. */
export function findSecretKeys(value: unknown, at = '$'): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findSecretKeys(item, `${at}[${index}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/pass(word)?|hash|senha/i.test(key)) found.push(`${at}.${key}`);
      found.push(...findSecretKeys(child, `${at}.${key}`));
    }
  }
  return found;
}

export function expectNoSecrets(value: unknown, label: string): void {
  expect(findSecretKeys(value), `${label}: nenhuma chave de senha/hash pode aparecer`).toEqual([]);
}

/** Versão do backend (package.json) — fonte da versão exposta em /health. */
export function backendVersion(): string {
  const pkg = JSON.parse(
    readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'backend', 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

// ---------------------------------------------------------------------------
// JWT (somente para montar tokens inválidos; o segredo real nunca é usado)
// ---------------------------------------------------------------------------

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, any> } {
  const [header, payload] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
  };
}

/** Mantém a assinatura original e troca o conteúdo do payload (ex.: role ADMIN). */
export function tamperPayload(token: string, changes: Record<string, unknown>): string {
  const [header, , signature] = token.split('.');
  const { payload } = decodeJwt(token);
  return `${header}.${b64url({ ...payload, ...changes })}.${signature}`;
}

/** Token sem assinatura (alg "none"). */
export function unsignedToken(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`;
}

/** Token HS256 assinado com um segredo qualquer (diferente do servidor). */
export function foreignSignedToken(payload: Record<string, unknown>): string {
  const head = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  const signature = createHmac('sha256', randomBytes(32)).update(head).digest('base64url');
  return `${head}.${signature}`;
}

/** Troca o último caractere da assinatura. */
export function corruptSignature(token: string): string {
  const last = token.slice(-1);
  return token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

// ---------------------------------------------------------------------------
// Imagens geradas em memória
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * PNG RGB válido. `noise` preenche com bytes aleatórios (não comprime), útil para
 * gerar imagens reais de tamanho controlado.
 */
export function makePng(width = 4, height = 4, { noise = false } = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // profundidade
  header[9] = 2; // RGB
  const rowLength = 1 + width * 3;
  const raw = noise ? randomBytes(rowLength * height) : Buffer.alloc(rowLength * height, 0x80);
  for (let row = 0; row < height; row++) raw[row * rowLength] = 0; // filtro "none" em cada linha
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: noise ? 0 : 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** JPEG 8x8 válido (gerado previamente com sharp). */
export const JPEG_8X8 = Buffer.from(
  '/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAEqA/9k=',
  'base64',
);

export const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

export const SVG_IMAGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>',
);

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

export const pngFile = (buffer: Buffer = makePng(), name = 'imagem.png') => ({ name, mimeType: 'image/png', buffer });

/** Largura/altura de um WebP (VP8, VP8L ou VP8X). */
export function webpSize(buffer: Buffer): { width: number; height: number } | null {
  if (!isWebp(buffer) || buffer.length < 30) return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** Pasta de uploads da API de teste (UPLOADS_DIR = e2e/.uploads). */
export function uploadedFiles(): string[] {
  return existsSync(E2E.uploadsDir) ? readdirSync(E2E.uploadsDir) : [];
}

/** Dimensões dos WebP gravados em /uploads que não estavam na lista `before`. */
export function newUploadSizes(before: Set<string>): Array<{ file: string; width: number; height: number }> {
  return uploadedFiles()
    .filter((file) => !before.has(file) && file.endsWith('.webp'))
    .map((file) => {
      try {
        const size = webpSize(readFileSync(path.join(E2E.uploadsDir, file)));
        return size ? { file, ...size } : null;
      } catch {
        return null; // arquivo ainda sendo gravado por outro processo
      }
    })
    .filter((entry): entry is { file: string; width: number; height: number } => entry !== null);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
