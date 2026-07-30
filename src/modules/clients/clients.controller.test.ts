import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state. vi.hoisted runs before vi.mock factories.
const { state } = vi.hoisted(() => ({
  state: {
    clientsRows: [] as Array<Record<string, any>>,
    insert: null as null | Record<string, any>,
    update: null as null | Record<string, any>,
    contactInsert: null as null | Record<string, any>,
    followupCount: 4 as number,
    taskRows: [] as Array<Record<string, any>>,
    taskUpdate: null as null | Record<string, any>,
  },
}));

// Test fixtures — proper RFC-4122 UUIDs so the controllers' UUID guards pass.
const C1 = "11111111-1111-4111-8111-111111111111";
const C_OTHER = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333";

/**
 * Build a fluent query-builder stub. Mirrors the Supabase client: every
 * chainable method returns the same builder; terminals (.maybeSingle /
 * .single / .limit) resolve the payload. The mock also HONORS any
 * `.eq("column", value)` filters by intersecting them with
 * `state.<table>Rows`, so the test can stage rows that look like a
 * Supabase RLS-filtered result.
 */
function makeQuery(tableKey: string, opts: { defaultResolve?: () => any } = {}) {
  const eqFilters: Array<{ col: string; val: any }> = [];
  const likeFilters: Array<{ col: string; val: string }> = [];
  const inFilters: Array<{ col: string; vals: any[] }> = [];
  const gteFilters: Array<{ col: string; val: any }> = [];
  let pendingInsert: any = null;
  let pendingUpdate: any = null;
  let lastChain: string[] = [];

  function applyFilters<T extends Record<string, any>>(rows: T[]): T[] {
    return rows.filter((row) => {
      for (const f of eqFilters) {
        if (row[f.col] !== f.val) return false;
      }
      for (const f of inFilters) {
        if (!f.vals.includes(row[f.col])) return false;
      }
      for (const f of gteFilters) {
        if (row[f.col] == null) return false;
        if (new Date(row[f.col]).getTime() < new Date(f.val).getTime()) return false;
      }
      for (const f of likeFilters) {
        if (typeof row[f.col] !== "string") return false;
        if (!row[f.col].toLowerCase().includes(f.val.toLowerCase().replace(/%/g, ""))) return false;
      }
      return true;
    });
  }

  const obj: any = {};
  const add = (label: string) => { lastChain.push(label); };
  obj.select = (..._args: any[]) => { add("select"); return obj; };
  obj.insert = (row: any) => {
    pendingInsert = row;
    add("insert");
    // Promote via the per-table shim if installed.
    if (tableKey === "clients") state.insert = row;
    if (tableKey === "contact_log") state.contactInsert = row;
    return obj;
  };
  obj.update = (patch: any) => {
    pendingUpdate = patch;
    add("update");
    if (tableKey === "clients") state.update = patch;
    if (tableKey === "followup_tasks") state.taskUpdate = patch;
    return obj;
  };
  obj.delete = () => { add("delete"); return obj; };
  obj.eq = (col: string, val: any) => { eqFilters.push({ col, val }); add("eq"); return obj; };
  obj.neq = () => { add("neq"); return obj; };
  obj.gt = () => { add("gt"); return obj; };
  obj.gte = (col: string, val: any) => { gteFilters.push({ col, val }); add("gte"); return obj; };
  obj.lt = () => { add("lt"); return obj; };
  obj.lte = () => { add("lte"); return obj; };
  obj.is = () => { add("is"); return obj; };
  obj.in = (col: string, vals: any[]) => { inFilters.push({ col, vals }); add("in"); return obj; };
  obj.ilike = (col: string, val: string) => { likeFilters.push({ col, val }); add("ilike"); return obj; };
  obj.order = () => { add("order"); return obj; };
  obj.limit = (..._args: any[]) => {
    add("limit");
    if (tableKey === "clients") {
      return Promise.resolve({ data: applyFilters(state.clientsRows), error: null });
    }
    return Promise.resolve(opts.defaultResolve?.() ?? { data: [], error: null });
  };
  obj.range = () => Promise.resolve({ data: [], error: null });
  obj.maybeSingle = () => {
    add("maybeSingle");
    if (tableKey === "clients") {
      const rows = applyFilters(state.clientsRows);
      const merged = rows[0]
        ? { ...rows[0], ...(pendingUpdate ?? {}) }
        : null;
      return Promise.resolve({ data: merged, error: null });
    }
    if (tableKey === "followup_tasks") {
      const rows = applyFilters(state.taskRows);
      const merged = rows[0]
        ? { ...rows[0], ...(pendingUpdate ?? {}) }
        : null;
      return Promise.resolve({ data: merged, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  obj.single = () => {
    add("single");
    if (tableKey === "clients") {
      const merged = pendingInsert
        ? { id: C1, ...pendingInsert }
        : pendingUpdate
        ? { ...state.clientsRows[0], ...pendingUpdate }
        : state.clientsRows[0] ?? null;
      return Promise.resolve({ data: merged, error: null });
    }
    if (tableKey === "contact_log") {
      return Promise.resolve({
        data: { id: "log-1", ...(pendingInsert ?? {}), created_at: "2026-07-30T00:00:00Z" },
        error: null,
      });
    }
    if (tableKey === "followup_tasks") {
      const merged = pendingUpdate
        ? { ...state.taskRows[0], ...pendingUpdate }
        : state.taskRows[0] ?? null;
      return Promise.resolve({ data: merged, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  // Bare-await path used by the count read-back in createMyClient:
  //   .select("id", {count,head}).eq("client_id", id).await
  obj.then = undefined as any;
  Object.defineProperty(obj, "then", {
    get() {
      return (onFulfilled: any) => {
        // Treat as count query: return { count, data: null, error: null }.
        if (tableKey === "followup_tasks") {
          return Promise.resolve({ count: state.followupCount, data: null, error: null })
            .then(onFulfilled);
        }
        return Promise.resolve({ data: [], error: null }).then(onFulfilled);
      };
    },
  });
  return obj;
}

vi.mock("../../config.js", () => ({
  env: { LOG_LEVEL: "warn", NODE_ENV: "test", OPENAI_MODEL: "gpt-4o-mini" },
  supabase: {
    from: (table: string) => {
      if (table !== "profiles") throw new Error("unmocked supabase table " + table);
      return makeQuery("profiles");
    },
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (
        table === "clients" ||
        table === "contact_log" ||
        table === "followup_tasks"
      ) {
        return makeQuery(table);
      }
      throw new Error("unmocked table " + table);
    },
  },
  getOpenAIClient: () => null, // graceful degradation
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import {
  listMyClients,
  createMyClient,
  getMyClient,
  patchMyClient,
  logMyContact,
} from "./clients.controller.js";
import { completeMyTask } from "../tasks/tasks.controller.js";

function makeReqRes(opts: {
  promoterId?: string;
  body?: any;
  params?: Record<string, string>;
  query?: Record<string, any>;
}) {
  const req: any = {
    body: opts.body ?? {},
    query: opts.query ?? {},
    params: opts.params ?? {},
    promoter: opts.promoterId ? { id: opts.promoterId, email: "kol@example.com", status: "active" } : undefined,
  };
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      // If the controller skips explicit res.status() and just calls
      // res.json() (a perfectly valid Express pattern, returns 200 by
      // default), make the mock reflect that.
      if (this.statusCode === 0) this.statusCode = 200;
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

beforeEach(() => {
  state.clientsRows = [];
  state.insert = null;
  state.update = null;
  state.contactInsert = null;
  state.followupCount = 4;
  state.taskRows = [];
  state.taskUpdate = null;
});

describe("clients controller — auth & ownership", () => {
  it("returns 401 when no promoter context (e.g. middleware not run)", async () => {
    const { req, res } = makeReqRes({});
    await listMyClients(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("GET /clients returns the KOL's clients", async () => {
    state.clientsRows = [{
      id: C1, promoter_id: "p1", display_name: "Alice",
      contact_channel: null, contact_handle: null, status: "lead",
      country_code: "US", age_range: "30-44", health_concerns: ["hair_loss"],
      budget_bracket: "10k_25k", last_contact_at: null, next_follow_up_at: null,
      created_at: "2026-07-01T00:00:00Z",
    }];
    const { req, res } = makeReqRes({ promoterId: "p1" });
    await listMyClients(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].display_name).toBe("Alice");
  });
});

describe("POST /clients — consent gate", () => {
  it("rejects missing consent_verified with 400", async () => {
    const { req, res } = makeReqRes({
      promoterId: "p1",
      body: { display_name: "Bob", consent_verified: false },
    });
    await createMyClient(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(state.insert).toBeNull();
  });

  it("inserts a new client and reports followup_tasks_created when consent_verified=true", async () => {
    const { req, res } = makeReqRes({
      promoterId: "p1",
      body: {
        display_name: "Carol",
        contact_channel: "wechat",
        contact_handle: "carol_wx",
        country_code: "CN",
        age_range: "30-44",
        health_concerns: ["hair_loss"],
        budget_bracket: "10k_25k",
        consent_verified: true,
      },
    });
    await createMyClient(req, res);
    expect(res.statusCode).toBe(201);
    expect(state.insert).not.toBeNull();
    expect(state.insert!.promoter_id).toBe("p1");
    expect(state.insert!.display_name).toBe("Carol");
    expect(state.insert!.status).toBe("lead");
    expect(res.body.followup_tasks_created).toBe(4);
  });
});

describe("GET/PATCH /clients/:id — ownership", () => {
  it("returns 404 when the client is owned by another KOL", async () => {
    // Stage the OTHER promoter only — the mock's eq(promoter_id, p1)
    // filter will exclude it, so the controller sees an empty set.
    state.clientsRows = [{
      id: C_OTHER, promoter_id: "OTHER", display_name: "Eve",
      contact_channel: null, contact_handle: null, status: "lead",
      country_code: null, age_range: null, health_concerns: [],
      budget_bracket: null, last_contact_at: null, next_follow_up_at: null,
      created_at: "2026-07-01T00:00:00Z",
    }];
    const { req, res } = makeReqRes({ promoterId: "p1", params: { id: C_OTHER } });
    await getMyClient(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 200 when the client belongs to the authenticated KOL", async () => {
    state.clientsRows = [{
      id: C1, promoter_id: "p1", display_name: "Mallory",
      contact_channel: null, contact_handle: null, status: "engaged",
      country_code: "US", age_range: "45-59", health_concerns: [],
      budget_bracket: null, last_contact_at: null, next_follow_up_at: null,
      created_at: "2026-07-01T00:00:00Z",
    }];
    const { req, res } = makeReqRes({ promoterId: "p1", params: { id: C1 } });
    await getMyClient(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.display_name).toBe("Mallory");
  });

  it("PATCH /clients/:id validates fields and returns the updated row", async () => {
    state.clientsRows = [{
      id: C1, promoter_id: "p1", display_name: "Peggy",
      contact_channel: null, contact_handle: null, status: "lead",
      country_code: null, age_range: null, health_concerns: [],
      budget_bracket: null, last_contact_at: null, next_follow_up_at: null,
      created_at: "2026-07-01T00:00:00Z",
    }];
    const { req, res } = makeReqRes({
      promoterId: "p1",
      params: { id: C1 },
      body: { status: "qualified", notes: "ready for proposal" },
    });
    await patchMyClient(req, res);
    expect(res.statusCode).toBe(200);
    expect(state.update).toMatchObject({
      status: "qualified",
      notes: "ready for proposal",
    });
    expect(state.update!.updated_at).toBeDefined();
  });

  it("POST /clients/:id/contacts logs the touch and degrades OpenAI suggestions to null", async () => {
    state.clientsRows = [{
      id: C1, promoter_id: "p1", display_name: "Trent",
      contact_channel: null, contact_handle: null, status: "engaged",
      country_code: null, age_range: null, health_concerns: [],
      budget_bracket: null, last_contact_at: null, next_follow_up_at: null,
      created_at: "2026-07-01T00:00:00Z",
    }];
    const { req, res } = makeReqRes({
      promoterId: "p1",
      params: { id: C1 },
      body: { channel: "wechat", direction: "outbound", summary: "Intro'd the hair-loss program" },
    });
    await logMyContact(req, res);
    expect(res.statusCode).toBe(201);
    expect(state.contactInsert).toMatchObject({
      promoter_id: "p1",
      channel: "wechat",
      direction: "outbound",
    });
    // OpenAI client is null in the test mock → suggestions degrade to null.
    expect(res.body.data.suggestions).toBeNull();
  });

  it("POST /clients/:id/contacts returns 404 for a client owned by another KOL", async () => {
    state.clientsRows = [{
      id: C_OTHER, promoter_id: "OTHER", display_name: "X",
      contact_channel: null, contact_handle: null, status: "lead",
      country_code: null, age_range: null, health_concerns: [],
      budget_bracket: null, last_contact_at: null, next_follow_up_at: null,
      created_at: "2026-07-01T00:00:00Z",
    }];
    const { req, res } = makeReqRes({
      promoterId: "p1",
      params: { id: C_OTHER },
      body: { channel: "wechat", direction: "outbound", summary: "noop" },
    });
    await logMyContact(req, res);
    expect(res.statusCode).toBe(404);
    expect(state.contactInsert).toBeNull();
  });
});

describe("POST /tasks/:id/complete", () => {
  it("returns 404 for a task owned by another KOL", async () => {
    state.taskRows = [{
      id: T1, promoter_id: "OTHER", client_id: C1, day: 1,
      task_type: "check_in", due_at: "2026-07-30T00:00:00Z",
      completed_at: null, dismissed_at: null,
    }];
    const { req, res } = makeReqRes({ promoterId: "p1", params: { id: T1 } });
    await completeMyTask(req, res);
    expect(res.statusCode).toBe(404);
    expect(state.taskUpdate).toBeNull();
  });

  it("marks the task complete with completed_at = now when owned by the caller", async () => {
    state.taskRows = [{
      id: T1, promoter_id: "p1", client_id: C1, day: 0,
      task_type: "intro", due_at: "2026-07-29T00:00:00Z",
      completed_at: null, dismissed_at: null,
    }];
    const { req, res } = makeReqRes({ promoterId: "p1", params: { id: T1 } });
    await completeMyTask(req, res);
    expect(res.statusCode).toBe(200);
    expect(state.taskUpdate).toBeDefined();
    expect(state.taskUpdate!.completed_at).toBeDefined();
  });

  it("returns 401 without promoter context", async () => {
    const { req, res } = makeReqRes({ params: { id: T1 } });
    await completeMyTask(req, res);
    expect(res.statusCode).toBe(401);
  });
});