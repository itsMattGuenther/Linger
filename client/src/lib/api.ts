/**
 * The typed HTTP client. Everything the frontend knows about the server goes
 * through here.
 *
 * Two rules from AGENTS shape this file. Every request and response type is
 * imported from `src/generated/` (ts-rs output from `linger-core`) — nothing on
 * the wire is described twice. And there is no `any` and no `as` cast across the
 * boundary: `send()` is the single place where an untyped response body becomes
 * a typed one, and it is one annotated assignment, not a cast.
 */
import type { Attachment } from "../generated/Attachment";
import type { AttachmentId } from "../generated/AttachmentId";
import type { AuthResponse } from "../generated/AuthResponse";
import type { ChangePasswordRequest } from "../generated/ChangePasswordRequest";
import type { CreateInviteRequest } from "../generated/CreateInviteRequest";
import type { CreateDmRequest } from "../generated/CreateDmRequest";
import type { CreateRoomRequest } from "../generated/CreateRoomRequest";
import type { ErrorBody } from "../generated/ErrorBody";
import type { ErrorCode } from "../generated/ErrorCode";
import type { ExportId } from "../generated/ExportId";
import type { ExportJob } from "../generated/ExportJob";
import type { ExportStarted } from "../generated/ExportStarted";
import type { Invite } from "../generated/Invite";
import type { InvitePreview } from "../generated/InvitePreview";
import type { KnockRequest } from "../generated/KnockRequest";
import type { CompletedPart } from "../generated/CompletedPart";
import type { CreateUploadRequest } from "../generated/CreateUploadRequest";
import type { LinkPreview } from "../generated/LinkPreview";
import type { LoginRequest } from "../generated/LoginRequest";
import type { MediaItem } from "../generated/MediaItem";
import type { MediaKind } from "../generated/MediaKind";
import type { RefreshRequest } from "../generated/RefreshRequest";
import type { RefreshResponse } from "../generated/RefreshResponse";
import type { RegisterRequest } from "../generated/RegisterRequest";
import type { Room } from "../generated/Room";
import type { RoomId } from "../generated/RoomId";
import type { SearchHit } from "../generated/SearchHit";
import type { ServerInfo } from "../generated/ServerInfo";
import type { SetupPreview } from "../generated/SetupPreview";
import type { SetupRequest } from "../generated/SetupRequest";
import type { UpdateMeRequest } from "../generated/UpdateMeRequest";
import type { UploadSlot } from "../generated/UploadSlot";
import type { UpdateRoomRequest } from "../generated/UpdateRoomRequest";
import type { UpdateServerRequest } from "../generated/UpdateServerRequest";
import type { User } from "../generated/User";
import type { UserId } from "../generated/UserId";

/** Everything REST lives under this prefix (PROTOCOL §1). */
const API_PREFIX = "/api/v1";

/**
 * A refusal from the server, carrying the PROTOCOL §1 envelope. `message` is
 * written to be shown to a person, so screens display it directly.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, body: ErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.retryAfterMs = body.retry_after_ms;
  }
}

/** The request never got an answer we could read: no network, wrong address, a
 *  proxy returning HTML. Distinct from `ApiError`, which is the server talking. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * A request that went out and was never answered within its deadline: it may
 * or may not have arrived (#118), so it is never reported as lost.
 */
export class UnconfirmedError extends TransportError {
  constructor(message: string) {
    super(message);
    this.name = "UnconfirmedError";
  }
}

/**
 * Every error code the client recognises. This list exists so a code coming off
 * the network can be *checked* rather than assumed, which is what keeps this
 * file free of casts. The `satisfies` clause makes TypeScript fail the build if
 * this ever falls out of step with the generated `ErrorCode` union — verified by
 * deleting a key and watching `pnpm check` refuse it.
 */
const ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVITE_INVALID: "INVITE_INVALID",
  INVITE_EXPIRED: "INVITE_EXPIRED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  UNSUPPORTED_MEDIA: "UNSUPPORTED_MEDIA",
  CONFLICT: "CONFLICT",
  INTERNAL: "INTERNAL",
} as const satisfies Record<ErrorCode, ErrorCode>;

function toErrorCode(value: unknown): ErrorCode | null {
  for (const code of Object.values(ERROR_CODES)) if (code === value) return code;
  return null;
}

/** Read a property off a value of unknown shape without asserting anything. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const found: unknown = Reflect.get(value, key);
  return found;
}

/** Runtime shape check, because a 502 from a reverse proxy is not JSON at all. */
function asErrorBody(value: unknown): ErrorBody | null {
  const error = field(value, "error");
  const message = field(error, "message");
  if (typeof message !== "string") return null;
  // Codes are additive within v1, so a newer server may send one this build has
  // never heard of. Fall back to INTERNAL and keep the server's own wording —
  // the message is what the person reads.
  const code = toErrorCode(field(error, "code")) ?? "INTERNAL";
  const retry = field(error, "retry_after_ms");
  return {
    code,
    message,
    retry_after_ms: typeof retry === "number" ? retry : null,
  };
}

export interface RequestOptions {
  body?: unknown;
  accessToken?: string;
  signal?: AbortSignal;
}

async function send(
  baseUrl: string,
  method: string,
  path: string,
  options: RequestOptions,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch {
    throw new TransportError(
      `Couldn't reach ${baseUrl}. Check the address and that the server is running.`,
    );
  }

  if (response.ok) return response;

  const parsed: unknown = await response.json().catch(() => null);
  const body = asErrorBody(parsed);
  if (body) throw new ApiError(response.status, body);
  throw new TransportError(
    `${baseUrl} answered with ${response.status}, but not in Linger's format. Is that address a Linger server?`,
  );
}

/** Bound response headers and bodies alike, so pending controls always recover. */
async function withDeadline<T>(
  options: RequestOptions,
  request: (bounded: RequestOptions) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, 30_000);
  try {
    return await request({ ...options, signal: controller.signal });
  } catch (error) {
    if (expired) throw new UnconfirmedError(
      "The server did not confirm the request. Check whether it arrived before trying again.",
    );
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

async function requestJson<T>(
  baseUrl: string,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return withDeadline(options, async (bounded) => {
  const response = await send(baseUrl, method, path, bounded);
  // The one place the wire becomes typed. `Response.json()` is untyped, and `T`
  // is always a ts-rs type generated from the server's own definition, so a
  // mismatch here is a server bug rather than a guess on our side.
  const parsed: T = await response.json();
  return parsed;
  });
}

async function requestVoid(
  baseUrl: string,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<void> {
  await withDeadline(options, (bounded) => send(baseUrl, method, path, bounded));
}

/** What the media grid is asking for (PROTOCOL §6). */
export interface MediaQuery {
  kind?: MediaKind | null;
  author?: UserId | null;
  /** Unix ms, inclusive. */
  since?: number | null;
  until?: number | null;
  /** The last item's `cursor` from the previous page. Opaque. */
  before?: string | null;
  limit?: number;
}

/** Built here rather than in the panel so the query shape lives with the call. */
export function mediaQuery(query: MediaQuery): string {
  const parts = new URLSearchParams();
  if (query.kind) parts.set("kind", query.kind);
  if (query.author) parts.set("author", query.author);
  if (query.since !== null && query.since !== undefined) parts.set("since", String(query.since));
  if (query.until !== null && query.until !== undefined) parts.set("until", String(query.until));
  if (query.before) parts.set("before", query.before);
  if (query.limit !== undefined) parts.set("limit", String(query.limit));
  const text = parts.toString();
  return text === "" ? "" : `?${text}`;
}

/** What the search surface is asking for (PROTOCOL §6). */
export interface SearchRequest {
  /** Words, not a query language. Handed over exactly as typed. */
  q: string;
  room: RoomId | null;
  author: UserId | null;
  /** The last hit's `cursor` from the previous page. Opaque. */
  before?: string | null;
  limit?: number;
}

/** Built here rather than in the panel, so the query shape lives with the call. */
export function searchQuery(query: SearchRequest): string {
  const parts = new URLSearchParams();
  parts.set("q", query.q);
  if (query.room) parts.set("room_id", query.room);
  if (query.author) parts.set("author_id", query.author);
  if (query.before) parts.set("before", query.before);
  if (query.limit !== undefined) parts.set("limit", String(query.limit));
  return `?${parts.toString()}`;
}

/**
 * Calls that need no account: everything on the way *in* to a server.
 */
export class PublicApi {
  constructor(readonly baseUrl: string) {}

  /** Cheap "is there a Linger server at this address" probe. */
  async health(signal?: AbortSignal): Promise<void> {
    await requestVoid(this.baseUrl, "GET", "/health", { signal });
  }

  invitePreview(code: string): Promise<InvitePreview> {
    return requestJson(this.baseUrl, "GET", `/auth/invite/${encodeURIComponent(code)}`);
  }

  setupPreview(token: string): Promise<SetupPreview> {
    return requestJson(this.baseUrl, "GET", `/setup/${encodeURIComponent(token)}`);
  }

  setup(request: SetupRequest): Promise<AuthResponse> {
    return requestJson(this.baseUrl, "POST", "/setup", { body: request });
  }

  login(request: LoginRequest): Promise<AuthResponse> {
    return requestJson(this.baseUrl, "POST", "/auth/login", { body: request });
  }

  register(request: RegisterRequest): Promise<AuthResponse> {
    return requestJson(this.baseUrl, "POST", "/auth/register", { body: request });
  }

  refresh(request: RefreshRequest): Promise<RefreshResponse> {
    return requestJson(this.baseUrl, "POST", "/auth/refresh", { body: request });
  }

  logout(refreshToken: string): Promise<void> {
    const body: RefreshRequest = { refresh_token: refreshToken };
    return requestVoid(this.baseUrl, "POST", "/auth/logout", { body });
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token dies, in Unix milliseconds. */
  expiresAt: number;
}

/** Turn the server's `expires_in` (seconds) into a moment we can compare to. */
export function expiryOf(expiresIn: number): number {
  return Date.now() + expiresIn * 1000;
}

/**
 * Where an `AuthedApi` gets its access token, and how it gets a new one
 * (docs/design/architecture.md, "Tokens across windows").
 *
 * Two kinds exist. The window that owns a sign-in holds its refresh token and
 * renews by rotating it (`RotatingTokens`). Every other window of the Buddy
 * list client *borrows* (`BorrowedTokens`): it holds only an access token and
 * asks the owner when that runs out. Refresh tokens rotate and a spent one
 * revokes the whole sign-in (PROTOCOL §2), so exactly one party may ever
 * spend one; this seam is what keeps it that way across windows.
 */
export interface TokenSource {
  readonly accessToken: string;
  /** When the access token dies, in Unix milliseconds. */
  readonly expiresAt: number;
  /**
   * Get a working access token. One renewal at a time: every caller waits on
   * the same one. Rejects when it could not renew, and ends the sign-in only
   * when the server says the sign-in is over.
   */
  renew(): Promise<void>;
  /** The refresh token, which only the owning source holds. */
  readonly refreshToken: string | null;
}

interface SignInHandlers {
  onTokens: (tokens: Tokens) => void;
  onSignedOut: (reason: string) => void;
}

/**
 * The owner's source: rotates the refresh token, one renewal in flight at a
 * time, and reports new tokens so they can be saved to the keyring.
 */
class RotatingTokens implements TokenSource {
  readonly #baseUrl: string;
  #tokens: Tokens;
  #refreshing: Promise<void> | null = null;
  readonly #handlers: SignInHandlers;

  constructor(baseUrl: string, tokens: Tokens, handlers: SignInHandlers) {
    this.#baseUrl = baseUrl;
    this.#tokens = tokens;
    this.#handlers = handlers;
  }

  get accessToken(): string {
    return this.#tokens.accessToken;
  }

  get expiresAt(): number {
    return this.#tokens.expiresAt;
  }

  get refreshToken(): string {
    return this.#tokens.refreshToken;
  }

  renew(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    const attempt = (async () => {
      const previous = this.#tokens.refreshToken;
      try {
        const fresh = await new PublicApi(this.#baseUrl).refresh({
          refresh_token: previous,
        });
        this.#tokens = {
          accessToken: fresh.access_token,
          refreshToken: fresh.refresh_token,
          expiresAt: expiryOf(fresh.expires_in),
        };
        this.#handlers.onTokens(this.#tokens);
      } catch (error) {
        // A refused refresh is the end of this sign-in: the token expired, or
        // it was already spent and the family got revoked. Either way the only
        // way back is signing in again. A temporary server error or rate limit
        // says nothing about the token, just like a network failure. Keep the
        // sign-in so a later request can try again (also used by restoreOne).
        if (
          error instanceof ApiError &&
          (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN")
        ) {
          this.#handlers.onSignedOut("Your sign-in expired. Please sign in again.");
        }
        throw error;
      } finally {
        this.#refreshing = null;
      }
    })();
    this.#refreshing = attempt;
    return attempt;
  }
}

/** An access token lent by the owner window, and until when it works. */
export interface Lent {
  token: string;
  expiresAt: number;
}

/**
 * A viewer window's source: an access token lent by the owner. It never
 * holds or spends a refresh token. When its token stops working it asks the
 * owner, saying which token failed, so an owner that has already renewed can
 * simply lend the newer one instead of renewing again.
 */
export class BorrowedTokens implements TokenSource {
  #lent: Lent;
  #asking: Promise<void> | null = null;
  readonly #ask: (stale: string) => Promise<Lent>;
  readonly refreshToken = null;

  constructor(lent: Lent, ask: (stale: string) => Promise<Lent>) {
    this.#lent = lent;
    this.#ask = ask;
  }

  get accessToken(): string {
    return this.#lent.token;
  }

  get expiresAt(): number {
    return this.#lent.expiresAt;
  }

  /** The owner renewed and sent the new token to every window. */
  lend(lent: Lent): void {
    this.#lent = lent;
  }

  renew(): Promise<void> {
    this.#asking ??= this.#ask(this.#lent.token)
      .then((lent) => this.lend(lent))
      .finally(() => {
        this.#asking = null;
      });
    return this.#asking;
  }
}

/**
 * A signed-in connection to one server.
 *
 * Access tokens last 15 minutes, so expiry during normal use is routine rather
 * than exceptional. When a call comes back `UNAUTHENTICATED` this renews the
 * token through its source and runs the call again, once. The source is what
 * makes renewal safe: the owning window rotates the refresh token one renewal
 * at a time, and every other window borrows (see `TokenSource`).
 */
export class AuthedApi {
  readonly baseUrl: string;
  readonly #source: TokenSource;

  constructor(baseUrl: string, tokens: Tokens, handlers: SignInHandlers);
  constructor(baseUrl: string, source: TokenSource);
  constructor(baseUrl: string, tokens: Tokens | TokenSource, handlers?: SignInHandlers) {
    this.baseUrl = baseUrl;
    if ("renew" in tokens) {
      this.#source = tokens;
    } else {
      if (!handlers) throw new Error("an owned sign-in needs its handlers");
      this.#source = new RotatingTokens(baseUrl, tokens, handlers);
    }
  }

  /** The refresh token, for signing out. Only the owning window has one. */
  get refreshToken(): string {
    const token = this.#source.refreshToken;
    if (token === null) throw new Error("a borrowed sign-in has no refresh token");
    return token;
  }

  /**
   * An access token good enough to hand to the gateway, renewed first if it
   * is about to expire. The gateway connection lives in the Tauri core and has
   * no refresh token of its own — on purpose, since two parties spending a
   * rotating refresh token revokes the family (PROTOCOL §2). This is the one
   * door it comes through.
   *
   * `force` is for the case where the server refused a token that had not
   * expired yet, which happens when a server comes back with new signing keys.
   */
  /**
   * The access token as it is right now, without renewing it: for handing to
   * a window that's opening when renewing can't be waited for. That window
   * asks again if it has stopped working.
   */
  heldToken(): { token: string; expiresAt: number } {
    return { token: this.#source.accessToken, expiresAt: this.#source.expiresAt };
  }

  async accessToken(force = false): Promise<{ token: string; expiresAt: number }> {
    const soon = Date.now() + 60_000;
    if (force || this.#source.expiresAt <= soon) await this.#source.renew();
    return { token: this.#source.accessToken, expiresAt: this.#source.expiresAt };
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.#withAuth((accessToken) =>
      requestJson<T>(this.baseUrl, "GET", path, { accessToken, signal }),
    );
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.#withAuth((accessToken) =>
      requestJson<T>(this.baseUrl, "POST", path, { accessToken, body }),
    );
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.#withAuth((accessToken) =>
      requestJson<T>(this.baseUrl, "PATCH", path, { accessToken, body }),
    );
  }

  /** For the endpoints that answer 204 and say nothing, like starring media. */
  put(path: string, body?: unknown): Promise<void> {
    return this.#withAuth((accessToken) =>
      requestVoid(this.baseUrl, "PUT", path, { accessToken, body }),
    );
  }

  /** `body` is for the two routes that identify what to remove in JSON rather
   *  than in the path — removing a notify rule is one (PROTOCOL §5). */
  delete(path: string, body?: unknown): Promise<void> {
    return this.#withAuth((accessToken) =>
      requestVoid(this.baseUrl, "DELETE", path, { accessToken, body }),
    );
  }

  me(signal?: AbortSignal): Promise<User> {
    return this.get<User>("/me", signal);
  }

  updateMe(request: UpdateMeRequest): Promise<User> {
    return this.patch<User>("/me", request);
  }

  changePassword(request: ChangePasswordRequest): Promise<void> {
    return this.#withAuth((accessToken) =>
      requestVoid(this.baseUrl, "PATCH", "/me/password", { accessToken, body: request }),
    );
  }

  serverInfo(signal?: AbortSignal): Promise<ServerInfo> {
    return this.get<ServerInfo>("/server", signal);
  }

  // --- the host's endpoints (PROTOCOL §3 and §7) ---------------------------
  //
  // All of these answer FORBIDDEN for anybody but the host, which is the lock;
  // the client hides the controls rather than greying them out, which is the
  // product decision on top of it.

  updateServer(request: UpdateServerRequest): Promise<ServerInfo> {
    return this.patch<ServerInfo>("/server", request);
  }

  createRoom(request: CreateRoomRequest): Promise<Room> {
    return this.post<Room>("/rooms", request);
  }

  updateRoom(id: RoomId, request: UpdateRoomRequest): Promise<Room> {
    return this.patch<Room>(`/rooms/${encodeURIComponent(id)}`, request);
  }

  /** The only delete this product has (SPEC §4.1): the room leaves the rail
   *  and everything in it is still there. */
  archiveRoom(id: RoomId): Promise<Room> {
    return this.post<Room>(`/rooms/${encodeURIComponent(id)}/archive`);
  }

  // --- DMs (SPEC §4.13, PROTOCOL §3.1) --------------------------------------

  /**
   * The DMs you are in. `ready` already carries them, so this is for a client
   * that wants them without a socket — nothing in the app calls it today, and
   * it is here because the endpoint exists and a half-mapped API is worse than
   * a mapped one.
   */
  dms(): Promise<Room[]> {
    return this.get<Room[]>("/dms");
  }

  /**
   * Open a DM with these people, or find the one that already exists.
   *
   * Create-*or-find*: asking twice for the same set of people gives the same
   * room, so this is safe to call from a button somebody might press twice.
   * `userIds` is everybody else — you are always in it and never name yourself
   * (PROTOCOL §3.1).
   */
  openDm(userIds: UserId[]): Promise<Room> {
    const request: CreateDmRequest = { user_ids: userIds };
    return this.post<Room>("/dms", request);
  }

  /**
   * Everybody the host has removed (T-413). A separate call rather than a flag
   * on `GET /users`, because the roster is a list of people who are here and a
   * removed member is not one of them.
   */
  removedUsers(signal?: AbortSignal): Promise<User[]> {
    return this.get<User[]>("/users/removed", signal);
  }

  /** Take somebody off the server. The word is "remove", never kick or ban
   *  (SPEC §1) — and there is no ban, because there is nothing to ban by. */
  removeUser(id: UserId): Promise<void> {
    return this.#withAuth((accessToken) =>
      requestVoid(this.baseUrl, "POST", `/users/${encodeURIComponent(id)}/remove`, {
        accessToken,
      }),
    );
  }

  /** Let them back in. Not an undo: their old sign-ins and the invites they
   *  made stay dead, so they come back through the front door. */
  restoreUser(id: UserId): Promise<void> {
    return this.#withAuth((accessToken) =>
      requestVoid(this.baseUrl, "POST", `/users/${encodeURIComponent(id)}/restore`, {
        accessToken,
      }),
    );
  }

  // --- uploads and the media collection (PROTOCOL §6) -----------------------

  /** Reserve a slot. The bytes go straight at `slot.url`, never through here. */
  createUpload(request: CreateUploadRequest): Promise<UploadSlot> {
    return this.post<UploadSlot>("/uploads", request);
  }

  /** Say the bytes are all there. This is where the server looks at them. */
  completeUpload(id: string, parts: CompletedPart[] | null): Promise<Attachment> {
    return this.post<Attachment>(`/uploads/${encodeURIComponent(id)}/complete`, { parts });
  }

  /** Throw an upload away, finished or not. */
  cancelUpload(id: string): Promise<void> {
    return this.delete(`/uploads/${encodeURIComponent(id)}`);
  }

  /**
   * A page of the media collection. `before` is the previous page's last
   * `cursor`, handed back untouched — it is opaque and must not be built,
   * parsed or compared (PROTOCOL §6).
   */
  media(query: MediaQuery, signal?: AbortSignal): Promise<MediaItem[]> {
    return this.get<MediaItem[]>(`/media${mediaQuery(query)}`, signal);
  }

  starMedia(id: AttachmentId): Promise<void> {
    return this.put(`/media/${encodeURIComponent(id)}/star`);
  }

  unstarMedia(id: AttachmentId): Promise<void> {
    return this.delete(`/media/${encodeURIComponent(id)}/star`);
  }

  /**
   * A page of search results (SPEC §4.12, PROTOCOL §6).
   *
   * `q` goes over as typed. The server pulls the words out of it and looks for
   * all of them — there is no query language to build here, and quietly turning
   * somebody's typing into operators is the thing SPEC §4.12 refuses.
   *
   * Newest first, always. Paging is keyset: hand the last hit's `cursor` back
   * as `before`, untouched.
   */
  search(query: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]> {
    return this.get<SearchHit[]>(`/search${searchQuery(query)}`, signal);
  }

  /**
   * Cards for the links about to be drawn. The server fetches them with its own
   * IP and hands the favicon back inline, so nothing here — and nothing in the
   * webview — ever touches the linked site (PROTOCOL §6).
   */
  linkPreviews(urls: string[]): Promise<LinkPreview[]> {
    return this.post<LinkPreview[]>("/links/preview", { urls });
  }

  /**
   * Ask the server for an archive of everything (SPEC §4.11, PROTOCOL §7).
   *
   * Any member, once an hour. A refusal is `RATE_LIMITED` carrying
   * `retryAfterMs`, which is a thing to say in words rather than an error to
   * show.
   */
  startExport(): Promise<ExportStarted> {
    return this.post<ExportStarted>("/export", {});
  }

  /** How far along that archive is, and where to get it once it exists. */
  exportJob(jobId: ExportId, signal?: AbortSignal): Promise<ExportJob> {
    return this.get<ExportJob>(`/export/${encodeURIComponent(jobId)}`, signal);
  }

  /**
   * Nudge one person (SPEC §4.9, PROTOCOL §7).
   *
   * Three an hour, per person you are knocking at, so a refusal is
   * `RATE_LIMITED` and means "you have already knocked at them" rather than
   * "the server is busy". Somebody who has been removed is `NOT_FOUND`.
   */
  knock(targetUserId: UserId): Promise<void> {
    return this.#withAuth((accessToken) =>
      requestVoid(this.baseUrl, "POST", "/knock", {
        accessToken,
        body: { target_user_id: targetUserId } satisfies KnockRequest,
      }),
    );
  }

  invites(signal?: AbortSignal): Promise<Invite[]> {
    return this.get<Invite[]>("/invites", signal);
  }

  createInvite(request: CreateInviteRequest): Promise<Invite> {
    return this.post<Invite>("/invites", request);
  }

  revokeInvite(code: string): Promise<void> {
    return this.delete(`/invites/${encodeURIComponent(code)}`);
  }

  async #withAuth<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      return await call(this.#source.accessToken);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "UNAUTHENTICATED") throw error;
      await this.#source.renew();
      return await call(this.#source.accessToken);
    }
  }
}
