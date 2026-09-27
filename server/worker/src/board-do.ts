/**
 * Board Durable Object: one DO ("musebook/boards") holds all boards.
 * Stores secrets as SHA-256 hashes; never plaintext.
 */

import { canonical, randomSecret, sha256Hex, safeEqual, verifyEnvelope } from "./crypto";

interface Member {
  pubkey: string; // canonical JWK JSON
  display_name: string;
  role: "admin" | "member";
  state: "pending" | "active";
  joined_at: string;
  vouched_by: string | null;
}

interface Invite {
  invite_id: string;
  secret_hash: string;
  role: "admin" | "member";
  note: string;
  created_at: string;
  expires_at: string;
  redeemed: boolean;
}

interface Board {
  id: string;
  name: string;
  key_epoch: number;
  created_at: string;
  members: Record<string, Member>; // keyed by canonical pubkey JSON
  invites: Record<string, Invite>;
  rooms: string[];
}

interface Post {
  post_id: string;
  seq: number;
  envelope: Record<string, unknown>;
  signature: string;
  stored_at: string;
}

interface ListItem {
  id: string;
  title: string;
  detail?: string;
  status: string;
  owner_side: string;
  origin_side: string;
  category?: string;
  added_at: string;
  updated_at: string;
  deleted?: boolean;
}

const MAX_TTL = 7 * 24 * 3600;

export class BoardDO {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method;
    try {
      // --- board admin ops (bearer: admin token) ---
      if (method === "POST" && parts.length === 2 && parts[0] === "admin" && parts[1] === "boards")
        return this.createBoard(await request.json());
      if (method === "POST" && parts.length === 3 && parts[0] === "boards" && parts[2] === "invites")
        return this.withMember(request, parts[1], "admin", async (m) =>
          this.mintInvite(parts[1], m, await request.json()));
      if (method === "DELETE" && parts.length === 4 && parts[0] === "boards" && parts[2] === "invites")
        return this.withMember(request, parts[1], "admin", () =>
          this.revokeInvite(parts[1], parts[3]));
      if (method === "POST" && parts.length === 3 && parts[0] === "boards" && parts[2] === "rooms")
        return this.withMember(request, parts[1], "admin", async () =>
          this.createRoom(parts[1], await request.json()));
      if (method === "POST" && parts.length === 5 && parts[0] === "boards" && parts[2] === "members" && parts[4] === "vouch")
        return this.withMember(request, parts[1], "admin", (m) =>
          this.vouch(parts[1], parts[3], m));
      if (method === "POST" && parts.length === 5 && parts[0] === "boards" && parts[2] === "members" && parts[4] === "revoke")
        return this.withMember(request, parts[1], "admin", () =>
          this.revokeMember(parts[1], parts[3]));
      if (method === "GET" && parts.length === 3 && parts[0] === "boards" && parts[2] === "members")
        return this.withMember(request, parts[1], "member", () =>
          this.listMembers(parts[1]));
      if (method === "GET" && parts.length === 3 && parts[0] === "boards" && parts[2] === "export")
        return this.withMember(request, parts[1], "admin", () =>
          this.exportBoard(parts[1]));
      if (method === "GET" && parts.length === 2 && parts[0] === "admin" && parts[1] === "boards")
        return this.listBoards();
      if (method === "DELETE" && parts.length === 3 && parts[0] === "admin" && parts[1] === "boards")
        return this.deleteBoard(parts[2]);

      // --- member ops ---
      if (method === "POST" && parts.length === 5 && parts[0] === "boards" && parts[2] === "rooms" && parts[4] === "posts")
        return this.withMember(request, parts[1], "member", async (m) =>
          this.post(parts[1], parts[3], m, await request.json()));
      if (method === "GET" && parts.length === 5 && parts[0] === "boards" && parts[2] === "rooms" && parts[4] === "posts")
        return this.withMember(request, parts[1], "member", () =>
          this.getPosts(parts[1], parts[3], url.searchParams.get("since")));
      if (method === "PUT" && parts.length === 6 && parts[0] === "boards" && parts[2] === "lists" && parts[4] === "items")
        return this.withMember(request, parts[1], "member", async (m) =>
          this.listOp(parts[1], parts[3], parts[5], m, await request.json()));
      if (method === "GET" && parts.length === 5 && parts[0] === "boards" && parts[2] === "lists" && parts[4] === "items")
        return this.withMember(request, parts[1], "member", () =>
          this.getItems(parts[1], parts[3]));

      // --- invite public / redeem ---
      if (method === "GET" && parts.length === 2 && parts[0] === "invite")
        return this.inviteInfo(parts[1]);
      if (method === "POST" && parts.length === 3 && parts[0] === "invite" && parts[2] === "redeem")
        return this.redeemInvite(parts[1], await request.json());

      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "internal", detail: String(e) }, 500);
    }
  }

  // ---------- helpers ----------

  private async getBoard(id: string): Promise<Board | null> {
    return (await this.state.storage.get<Board>(`board:${id}`)) ?? null;
  }
  private putBoard(b: Board) {
    return this.state.storage.put(`board:${b.id}`, b);
  }
  private memberKey(pubkeyCanon: string) {
    return pubkeyCanon;
  }

  private async withMember(
    request: Request,
    boardId: string,
    minRole: "admin" | "member",
    fn: (m: { pubkey: string; member: Member }) => Promise<Response>
  ): Promise<Response> {
    const board = await this.getBoard(boardId);
    if (!board) return json({ error: "board_not_found" }, 404);
    const token = bearer(request);
    if (!token) return json({ error: "unauthorized" }, 401);
    const h = await sha256Hex("token:" + token);
    const rec = await this.state.storage.get<{ pubkey: string }>(`token:${h}`);
    if (!rec) return json({ error: "unauthorized" }, 401);
    const member = board.members[this.memberKey(rec.pubkey)];
    if (!member || member.state !== "active")
      return json({ error: "forbidden", detail: "not active" }, 403);
    if (minRole === "admin" && member.role !== "admin")
      return json({ error: "forbidden", detail: "admin only" }, 403);
    return fn({ pubkey: rec.pubkey, member });
  }

  private canonPubkey(jwk: unknown): string {
    return canonical(jwk);
  }

  // ---------- board admin ----------

  private async createBoard(body: {
    name?: string;
    admin_pubkey?: JsonWebKey;
    admin_display_name?: string;
  }): Promise<Response> {
    if (!body?.name || !body?.admin_pubkey || !body?.admin_display_name)
      return json({ error: "bad_request", detail: "name, admin_pubkey, admin_display_name required" }, 400);
    const id = "b_" + randomSecret(12);
    const pubkey = this.canonPubkey(body.admin_pubkey);
    const now = new Date().toISOString();
    const board: Board = {
      id,
      name: body.name,
      key_epoch: 1,
      created_at: now,
      members: {
        [pubkey]: {
          pubkey,
          display_name: body.admin_display_name,
          role: "admin",
          state: "active",
          joined_at: now,
          vouched_by: "self",
        },
      },
      invites: {},
      rooms: ["general"],
    };
    await this.putBoard(board);
    const token = randomSecret();
    await this.state.storage.put(`token:${await sha256Hex("token:" + token)}`, { pubkey });
    return json({ board_id: id, name: board.name, key_epoch: 1, admin_token: token });
  }

  private async listBoards(): Promise<Response> {
    const boards = await this.state.storage.list<Board>({ prefix: "board:" });
    return json({
      boards: [...boards.values()].map((b) => ({
        board_id: b.id,
        name: b.name,
        key_epoch: b.key_epoch,
        created_at: b.created_at,
        rooms: b.rooms,
        member_count: Object.keys(b.members).length,
        invite_count: Object.keys(b.invites).length,
      })),
    });
  }

  private async deleteBoard(boardId: string): Promise<Response> {
    const board = await this.getBoard(boardId);
    if (!board) return json({ error: "board_not_found" }, 404);
    await this.state.storage.delete(`board:${boardId}`);
    for (const room of board.rooms) {
      await this.state.storage.delete(`posts:${boardId}:${room}`);
    }
    const listKeys = await this.state.storage.list({ prefix: `list:${boardId}:` });
    for (const name of listKeys.keys()) {
      await this.state.storage.delete(name);
    }
    // sweep member tokens for this board so nothing accumulates
    const memberPubkeys = new Set(Object.keys(board.members));
    const tokenKeys = await this.state.storage.list({ prefix: "token:" });
    for (const [name, rec] of tokenKeys) {
      const r = rec as { pubkey?: string } | undefined;
      if (r?.pubkey && memberPubkeys.has(r.pubkey)) {
        await this.state.storage.delete(name);
      }
    }
    return json({ deleted: true, board_id: boardId });
  }

  private async mintInvite(boardId: string, admin: { pubkey: string }, body: {
    role?: "admin" | "member";
    ttl_seconds?: number;
    note?: string;
  }): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    const role = body?.role === "admin" ? "admin" : "member";
    const ttl = Math.min(Math.max(body?.ttl_seconds ?? 86400, 60), MAX_TTL);
    const invite_id = "inv_" + randomSecret(12);
    const secret = randomSecret();
    const now = Date.now();
    board.invites[invite_id] = {
      invite_id,
      secret_hash: await sha256Hex("invite:" + secret),
      role,
      note: String(body?.note ?? ""),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl * 1000).toISOString(),
      redeemed: false,
    };
    await this.putBoard(board);
    return json({
      invite_id,
      invite_url: `/join/${invite_id}#${secret}`,
      expires_at: board.invites[invite_id].expires_at,
      role,
    });
  }

  private async revokeInvite(boardId: string, inviteId: string): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    if (!board.invites[inviteId]) return json({ error: "invite_not_found" }, 404);
    delete board.invites[inviteId];
    await this.putBoard(board);
    return json({ revoked: true });
  }

  private async createRoom(boardId: string, body: { name?: string }): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    const name = String(body?.name ?? "").trim().toLowerCase();
    if (!name || !/^[a-z0-9_-]{1,32}$/.test(name))
      return json({ error: "bad_request", detail: "invalid room name" }, 400);
    if (!board.rooms.includes(name)) {
      board.rooms.push(name);
      await this.putBoard(board);
    }
    return json({ room: name, rooms: board.rooms });
  }

  private async vouch(boardId: string, pubkeyB64: string, admin: { pubkey: string }): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    const pubkey = decodeURIComponent(pubkeyB64);
    const m = board.members[pubkey];
    if (!m) return json({ error: "member_not_found" }, 404);
    m.state = "active";
    m.vouched_by = admin.pubkey;
    await this.putBoard(board);
    return json({ vouched: true, display_name: m.display_name });
  }

  private async revokeMember(boardId: string, pubkeyB64: string): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    const pubkey = decodeURIComponent(pubkeyB64);
    if (!board.members[pubkey]) return json({ error: "member_not_found" }, 404);
    delete board.members[pubkey];
    board.key_epoch += 1;
    // kill their tokens
    const tokens = await this.state.storage.list<{ pubkey: string }>({ prefix: "token:" });
    for (const [k, v] of tokens) {
      if (v.pubkey === pubkey) await this.state.storage.delete(k);
    }
    await this.putBoard(board);
    // system post announcing the epoch change
    await this.systemPost(board, `member removed — key epoch now ${board.key_epoch}; rejoin needs a fresh invite + keypair`);
    return json({ revoked: true, key_epoch: board.key_epoch });
  }

  private async listMembers(boardId: string): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    const members = Object.values(board.members).map((m) => ({
      display_name: m.display_name,
      role: m.role,
      state: m.state,
      joined_at: m.joined_at,
      vouched_by: m.vouched_by ? "vouched" : null,
      key_epoch: board.key_epoch,
    }));
    return json({ members, key_epoch: board.key_epoch, rooms: board.rooms });
  }

  private async exportBoard(boardId: string): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    const posts: Record<string, Post[]> = {};
    for (const room of board.rooms) {
      posts[room] = (await this.state.storage.get<Post[]>(`posts:${boardId}:${room}`)) ?? [];
    }
    const lists: Record<string, Record<string, ListItem>> = {};
    const listKeys = await this.state.storage.list({ prefix: `list:${boardId}:` });
    for (const name of listKeys.keys()) {
      lists[name.split(":").pop()!] = (await this.state.storage.get<Record<string, ListItem>>(name)) ?? {};
    }
    return json({ board: { ...board, invites: undefined }, posts, lists });
  }

  // ---------- invites ----------

  private async inviteInfo(inviteId: string): Promise<Response> {
    // find the board holding this invite
    const boards = await this.state.storage.list<Board>({ prefix: "board:" });
    let board: Board | null = null;
    for (const b of boards.values()) {
      if (b.invites[inviteId]) { board = b; break; }
    }
    const inv = board?.invites[inviteId];
    if (!inv || inv.redeemed || new Date(inv.expires_at).getTime() < Date.now())
      return json({ error: "invite_invalid" }, 404);
    return json({
      board_name: board!.name,
      role: inv.role,
      note: inv.note,
      expires_at: inv.expires_at,
    });
  }

  private async redeemInvite(boardId: string, body: {
    secret?: string;
    pubkey?: JsonWebKey;
    display_name?: string;
  }): Promise<Response> {
    // invite_id arrives as the `boardId` param here (route /invite/:id/redeem)
    const inviteId = boardId;
    if (!body?.secret || !body?.pubkey || !body?.display_name)
      return json({ error: "bad_request", detail: "secret, pubkey, display_name required" }, 400);
    // find the board holding this invite
    const boards = await this.state.storage.list<Board>({ prefix: "board:" });
    let board: Board | null = null;
    for (const b of boards.values()) {
      if (b.invites[inviteId]) { board = b; break; }
    }
    if (!board) return json({ error: "invite_invalid" }, 404);
    const inv = board.invites[inviteId];
    if (inv.redeemed || new Date(inv.expires_at).getTime() < Date.now())
      return json({ error: "invite_invalid" }, 404);
    if (!safeEqual(await sha256Hex("invite:" + body.secret), inv.secret_hash))
      return json({ error: "invite_invalid" }, 404);
    const pubkey = this.canonPubkey(body.pubkey);
    if (board.members[pubkey])
      return json({ error: "member_exists", detail: "this key is already a member of the board" }, 409);
    const now = new Date().toISOString();
    board.members[pubkey] = {
      pubkey,
      display_name: String(body.display_name).slice(0, 80),
      role: inv.role,
      state: "pending",
      joined_at: now,
      vouched_by: null,
    };
    inv.redeemed = true;
    await this.putBoard(board);
    const token = randomSecret();
    await this.state.storage.put(`token:${await sha256Hex("token:" + token)}`, { pubkey });
    return json({
      member_token: token,
      state: "pending",
      board_id: board.id,
      board_name: board.name,
      note: "awaiting vouch from the inviter before posting",
    });
  }

  // ---------- posts ----------

  private async post(boardId: string, room: string, m: { pubkey: string }, body: {
    envelope?: Record<string, unknown>;
    signature?: string;
  }): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    if (!board.rooms.includes(room)) return json({ error: "room_not_found" }, 404);
    const env = body?.envelope;
    const sig = body?.signature;
    if (!env || typeof sig !== "string")
      return json({ error: "bad_request", detail: "envelope + signature required" }, 400);
    if (env["board_id"] !== boardId || env["room"] !== room || env["sender_pubkey"] !== m.pubkey)
      return json({ error: "bad_request", detail: "envelope/board/room/sender mismatch" }, 400);
    const ts = Date.parse(String(env["timestamp"] ?? ""));
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60 * 1000)
      return json({ error: "bad_request", detail: "timestamp outside ±10 min replay window" }, 400);
    const pubkeyJwk = JSON.parse(m.pubkey) as JsonWebKey;
    if (!(await verifyEnvelope(env, sig, pubkeyJwk)))
      return json({ error: "bad_signature" }, 401);
    const key = `posts:${boardId}:${room}`;
    const posts = (await this.state.storage.get<Post[]>(key)) ?? [];
    const post: Post = {
      post_id: "p_" + randomSecret(8),
      seq: posts.length + 1,
      envelope: env,
      signature: sig,
      stored_at: new Date().toISOString(),
    };
    posts.push(post);
    await this.state.storage.put(key, posts);
    return json({ post_id: post.post_id, seq: post.seq });
  }

  private async getPosts(boardId: string, room: string, since: string | null): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    if (!board.rooms.includes(room)) return json({ error: "room_not_found" }, 404);
    const posts = (await this.state.storage.get<Post[]>(`posts:${boardId}:${room}`)) ?? [];
    const s = since ? parseInt(since, 10) : 0;
    return json({ posts: posts.filter((p) => p.seq > s), latest_seq: posts.length });
  }

  private async systemPost(board: Board, text: string): Promise<void> {
    const key = `posts:${board.id}:general`;
    const posts = (await this.state.storage.get<Post[]>(key)) ?? [];
    posts.push({
      post_id: "p_" + randomSecret(8),
      seq: posts.length + 1,
      envelope: { board_id: board.id, room: "general", sender_pubkey: "system", body: text, timestamp: new Date().toISOString() },
      signature: "system",
      stored_at: new Date().toISOString(),
    });
    await this.state.storage.put(key, posts);
  }

  // ---------- lists ----------

  private async listOp(boardId: string, list: string, itemId: string, m: { pubkey: string }, body: {
    op?: string;
    item?: ListItem;
  }): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    if (!/^[a-z0-9_-]{1,32}$/.test(list)) return json({ error: "bad_request" }, 400);
    const valid = ["add", "update", "done", "delete"];
    if (!body?.op || !valid.includes(body.op) || !body?.item)
      return json({ error: "bad_request", detail: "op + item required" }, 400);
    const key = `list:${boardId}:${list}`;
    const items = (await this.state.storage.get<Record<string, ListItem>>(key)) ?? {};
    const now = new Date().toISOString();
    const incoming = body.item;
    const cur = items[itemId];
    const incUpdated = incoming.updated_at ?? now;
    if (body.op === "delete") {
      if (!cur || (cur.updated_at ?? "") > incUpdated) { /* keep */ }
      else if ((cur.updated_at ?? "") === incUpdated && (cur.owner_side ?? "") > (incoming.owner_side ?? "")) { /* keep */ }
      else items[itemId] = { ...cur, ...incoming, id: itemId, deleted: true, updated_at: incUpdated };
    } else {
      const merged: ListItem = {
        ...(cur ?? {}),
        ...incoming,
        id: itemId,
        status: body.op === "done" ? "done" : incoming.status ?? cur?.status ?? "proposed",
        updated_at: incUpdated,
        deleted: false,
      };
      if (!cur) items[itemId] = merged;
      else if (incUpdated > (cur.updated_at ?? "")) items[itemId] = merged;
      else if (incUpdated === (cur.updated_at ?? "") && (merged.owner_side ?? "") > (cur.owner_side ?? "")) items[itemId] = merged;
    }
    await this.state.storage.put(key, items);
    return json({ ok: true, item: items[itemId] });
  }

  private async getItems(boardId: string, list: string): Promise<Response> {
    const board = (await this.getBoard(boardId))!;
    const items = (await this.state.storage.get<Record<string, ListItem>>(`list:${boardId}:${list}`)) ?? {};
    return json({ items });
  }
}

function bearer(request: Request): string | null {
  const h = request.headers.get("Authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
