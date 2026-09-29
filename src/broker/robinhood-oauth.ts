// Vendored from fall_forward_labs agent/src/broker/robinhood-oauth.ts @ e29a4c5 (same owner).
// Changes: token path defaults to ~/.config/fifty/, repo-root check uses this project's root,
// tools/list helper inlined, RELOGIN text points at `fifty login`.
// Sign-in for Robinhood's trading MCP server, which uses the standard MCP authorization flow
// (OAuth 2.1 authorization code + PKCE, discovered from the server's protected-resource
// metadata, with dynamic client registration). The protocol itself is the pinned
// @modelcontextprotocol/sdk's `auth()`; this file only supplies the OAuthClientProvider it
// needs: where the registration and tokens live, and how the browser is opened.
//
// Two ways in:
//   - login(): `fifty login`, interactive. Opens the system browser, waits on a
//     loopback callback, checks `state`, stores the result, then lists tools once to confirm.
//   - storedAuthTransport(): every other caller (schema check, gateway, recorder). Never opens
//     a browser: no stored sign-in, or an expired one that cannot be refreshed, is an error
//     telling the founder to re-run login.
//
// The token file lives outside the repo (tokenPath()), is written 0600 by an atomic rename,
// and no token value is ever logged. Refresh tokens are single-use and the recorder and gateway
// are separate processes on one host, so every refresh runs under a lock beside the token file
// (file-lock.ts) and first re-reads the file: a process that waited adopts the tokens the
// holder just stored instead of spending the same refresh token a second time.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, renameSync, writeSync, closeSync, fsyncSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { withFileLock } from "./file-lock.js";
import { projectRoot } from "../paths.js";

export const TOKEN_PATH_ENV = "FIFTY_TOKEN_PATH";
export const RELOGIN = "run `fifty login` on this Mac to sign in again";
/** Bounds how long the refresh lock can be held by a live process (file-lock.ts staleMs is 60s). */
const REFRESH_TIMEOUT_MS = 20_000;

/** What the token file holds. scripts/ops/preflight.py reads the same fields. */
export interface StoredAuth {
  server_url: string;
  client_information: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  /** Absolute expiry of tokens.access_token, from expires_in at the moment it was saved. */
  expires_at_ms?: number;
}

export function tokenPath(): string {
  const file = path.resolve(process.env[TOKEN_PATH_ENV] ?? path.join(os.homedir(), ".config", "fifty", "robinhood-oauth.json"));
  const rel = path.relative(projectRoot(), file);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error(`${file} is inside the repository; the Robinhood token file must live outside it (${TOKEN_PATH_ENV})`);
  }
  return file;
}

export function readStoredAuth(file: string): StoredAuth | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const data = JSON.parse(text) as Partial<StoredAuth>;
  if (typeof data.server_url !== "string" || !data.client_information || typeof data.tokens?.access_token !== "string") {
    throw new Error(`${file} is not a complete Robinhood sign-in; ${RELOGIN}`);
  }
  return data as StoredAuth;
}

function writeStoredAuth(file: string, data: StoredAuth): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A fresh 0600 file renamed over the old one, so the mode never depends on what was there.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

function isExpired(stored: StoredAuth, now: number): boolean {
  return stored.expires_at_ms !== undefined && stored.expires_at_ms <= now;
}

/** A token-endpoint response carrying stored tokens, with expires_in recomputed from now. */
function tokenResponse(stored: StoredAuth): Response {
  const { expires_in: _stale, ...tokens } = stored.tokens;
  const body = stored.expires_at_ms === undefined ? tokens : { ...tokens, expires_in: Math.max(0, Math.floor((stored.expires_at_ms - Date.now()) / 1000)) };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

class FileOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;
  readonly expectedState = randomBytes(16).toString("base64url");
  /** Why the last refresh failed. The SDK swallows non-OAuth refresh errors and falls through to
   *  redirectToAuthorization, which reports this instead of a bare "sign in again". */
  refreshError: unknown;

  constructor(
    private readonly file: string,
    private readonly serverUrl: string,
    private readonly redirect: string,
    private readonly onRedirect: (authorizationUrl: URL) => Promise<void>,
    private record: Partial<StoredAuth>,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "fifty session runner",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.record.client_information;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    // Held in memory until tokens arrive, so a login abandoned halfway never overwrites a
    // working sign-in with a registration that has no tokens.
    this.record.client_information = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.record.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    // A refresh through fetch() below has already stored these under the lock; writing them
    // again here, outside it, could overwrite a newer refresh by the other process.
    if (tokens.access_token === this.record.tokens?.access_token) return;
    this.persist(tokens);
  }

  private persist(tokens: OAuthTokens): void {
    if (!this.record.client_information) throw new Error("OAuth tokens arrived before client registration");
    const stored: StoredAuth = {
      server_url: this.serverUrl,
      client_information: this.record.client_information,
      tokens,
      ...(tokens.expires_in !== undefined ? { expires_at_ms: Date.now() + tokens.expires_in * 1000 } : {}),
    };
    writeStoredAuth(this.file, stored);
    this.record = stored;
  }

  /** Passed to the transport and to auth() as their fetch. It is the one seam every SDK token
   *  request goes through (the up-front refresh here and the transport's refresh on a 401), so
   *  refresh-grant requests are run under the lock; everything else passes straight through. */
  readonly fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    if (!(body instanceof URLSearchParams) || body.get("grant_type") !== "refresh_token") return fetch(url, init);
    try {
      return await withFileLock(`${this.file}.lock`, () => this.refreshLocked(url, init!, body.get("refresh_token")));
    } catch (err) {
      this.refreshError = err;
      throw err;
    }
  };

  private async refreshLocked(url: string | URL, init: RequestInit, sent: string | null): Promise<Response> {
    const current = readStoredAuth(this.file);
    if (current?.tokens.refresh_token && current.tokens.refresh_token !== sent) {
      this.record = current; // another process refreshed while this one waited
      return tokenResponse(current);
    }
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
    if (!res.ok) return res;
    const tokens = (await res.json()) as OAuthTokens;
    if (typeof tokens.access_token !== "string") throw new Error("the token endpoint returned no access_token");
    // The SDK keeps the old refresh token when none comes back; so must the stored copy.
    this.persist({ ...(sent ? { refresh_token: sent } : {}), ...tokens });
    return tokenResponse(this.record as StoredAuth);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onRedirect(authorizationUrl);
  }

  /** Called by the SDK when the server rejects a refresh (invalid_grant) or the client. Only the
   *  in-memory copy is dropped, so the SDK falls through to redirectToAuthorization, which for a
   *  stored sign-in is the re-login error. The file is left for the founder's next login. */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") this.record.tokens = undefined;
    if (scope === "all" || scope === "client") this.record.client_information = undefined;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("no PKCE code verifier for this sign-in");
    return this.verifier;
  }
}

/** The provider every non-interactive connection uses. Refreshes an expired access token up
 *  front when a refresh token exists; otherwise fails closed. */
async function storedAuthProvider(serverUrl: string, file: string): Promise<FileOAuthProvider> {
  const stored = readStoredAuth(file);
  if (!stored) throw new Error(`no Robinhood sign-in found at ${file}; ${RELOGIN}`);
  if (stored.server_url !== serverUrl) {
    throw new Error(`the Robinhood sign-in at ${file} is for a different server URL than ROBINHOOD_MCP_URL; ${RELOGIN}`);
  }
  const expired = isExpired(stored, Date.now());
  if (expired && !stored.tokens.refresh_token) {
    throw new Error(`the Robinhood sign-in at ${file} has expired and has no refresh token; ${RELOGIN}`);
  }
  const redirect = (stored.client_information as { redirect_uris?: string[] }).redirect_uris?.[0] ?? "http://127.0.0.1/callback";
  const provider: FileOAuthProvider = new FileOAuthProvider(file, serverUrl, redirect, async () => {
    const why = provider.refreshError instanceof Error ? `: ${provider.refreshError.message}` : "";
    throw new Error(`Robinhood needs a new sign-in (the stored one was rejected and could not be refreshed${why}); ${RELOGIN}`);
  }, stored);
  if (expired) {
    try {
      await auth(provider, { serverUrl, fetchFn: provider.fetch });
    } catch (err) {
      throw new Error(`the Robinhood sign-in at ${file} has expired and refreshing it failed (${err instanceof Error ? err.message : String(err)}); ${RELOGIN}`);
    }
  }
  return provider;
}

/** A transport to serverUrl signed in with the stored sign-in, refreshing it under the lock. */
export async function storedAuthTransport(serverUrl: string, file = tokenPath()): Promise<StreamableHTTPClientTransport> {
  const provider = await storedAuthProvider(serverUrl, file);
  return new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider, fetch: provider.fetch });
}

interface Callback {
  redirectUrl: string;
  code: Promise<string>;
  close: () => void;
}

/** A one-shot loopback listener for the authorization redirect. Rejects a callback whose
 *  `state` is not the one this login sent (CSRF / a stale or foreign redirect). */
async function listenForCallback(expectedState: () => string, timeoutMs: number): Promise<Callback> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => undefined); // may settle before login() awaits it; login() still sees the rejection
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const finish = (status: number, message: string) => res.writeHead(status, { "content-type": "text/plain" }).end(message);
    if (url.searchParams.get("state") !== expectedState()) {
      finish(400, "Sign-in rejected: state did not match. Close this tab and run fifty login again.");
      rejectCode(new Error("authorization callback state did not match the one this login sent; rejected"));
      return;
    }
    const error = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    if (error || !got) {
      finish(400, "Sign-in did not complete. Close this tab and check the terminal.");
      rejectCode(new Error(`authorization server returned ${error ?? "no code"}`));
      return;
    }
    finish(200, "Signed in. You can close this tab and return to the terminal.");
    resolveCode(got);
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const timer = setTimeout(() => rejectCode(new Error(`no sign-in completed within ${timeoutMs / 1000}s`)), timeoutMs);
  const { port } = server.address() as { port: number };
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    code,
    close: () => {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Opens a URL with the desktop's own opener. The URL carries only the PKCE challenge and
 *  state, never a secret. */
export function openInBrowser(url: URL): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  return new Promise((res, rej) => execFile(opener, [url.href], (err) => (err ? rej(err) : res())));
}

export interface LoginOptions {
  serverUrl: string;
  file?: string;
  openUrl?: (url: URL) => Promise<void>;
  timeoutMs?: number;
}

/** Interactive sign-in. Stores the tokens, then only lists tools to confirm the connection
 *  works; returns the tool count. Never calls a tool. */
export async function login(opts: LoginOptions): Promise<number> {
  const file = opts.file ?? tokenPath();
  const openUrl = opts.openUrl ?? openInBrowser;
  let provider: FileOAuthProvider | undefined;
  const callback = await listenForCallback(() => provider!.expectedState, opts.timeoutMs ?? 5 * 60_000);
  try {
    // Starts empty: a login always registers afresh for this run's loopback port.
    provider = new FileOAuthProvider(file, opts.serverUrl, callback.redirectUrl, openUrl, {});
    const first = new StreamableHTTPClientTransport(new URL(opts.serverUrl), { authProvider: provider });
    const probe = new Client({ name: "fifty-login", version: "0.1.0" });
    let redirected = false;
    try {
      await probe.connect(first);
    } catch (err) {
      if (!provider.tokens() && err instanceof UnauthorizedError) redirected = true;
      else throw err;
    }
    if (!redirected) {
      await probe.close();
      throw new Error("the server accepted a connection without asking for sign-in; nothing was stored");
    }
    await first.finishAuth(await callback.code);
  } finally {
    callback.close();
  }

  const client = new Client({ name: "fifty-login", version: "0.1.0" });
  await client.connect(await storedAuthTransport(opts.serverUrl, file));
  try {
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      count += page.tools.length;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return count;
  } finally {
    await client.close();
  }
}
