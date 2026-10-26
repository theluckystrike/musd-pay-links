// Atomic claims for invoice references and paid transaction hashes.
//
// KV is a read cache. A Durable Object per chain is the source of truth. Every claim is a compare-and-set
// inside one storage transaction, so two concurrent creates cannot take the same reference and one
// transaction hash cannot mark two invoices paid.

import type { StoredInvoice } from "./invoices.ts";

export type Paid = NonNullable<StoredInvoice["paid"]>;

export interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

export type CreateClaim = { status: "ok" } | { status: "taken"; invoice: StoredInvoice };

export type PayClaim =
  | { status: "paid"; invoice: StoredInvoice }
  /** Another transaction already paid this invoice. */
  | { status: "already_paid"; invoice: StoredInvoice }
  /** The transaction is already claimed by another invoice. */
  | { status: "tx_used"; owner: string };

export interface InvoiceClaims {
  get(chainId: number, memo: string): Promise<StoredInvoice | null>;
  owner(chainId: number, txHash: string): Promise<string | null>;
  create(chainId: number, invoice: StoredInvoice): Promise<CreateClaim>;
  /** Copy a record into the store only when it is absent. Used for lazy migration from KV. */
  import(chainId: number, invoice: StoredInvoice): Promise<StoredInvoice>;
  pay(chainId: number, invoice: StoredInvoice, payment: Paid): Promise<PayClaim>;
}

const invKey = (memo: string) => `inv:${memo}`;
const txKey = (hash: string) => `tx:${hash.toLowerCase()}`;

function checkChain(chainId: number, invoice: StoredInvoice): void {
  if (invoice.chainId !== chainId) throw new Error(`Invoice ${invoice.memo} belongs to chain ${invoice.chainId}, not ${chainId}.`);
}

/**
 * The source of truth. One instance holds the invoices of one chain. A Durable Object handles one
 * request at a time and `storage.transaction` makes the read and the write atomic, so the checks below
 * cannot interleave with another request.
 */
export class InvoiceStoreDO {
  private readonly storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
  }

  async get(chainId: number, memo: string): Promise<StoredInvoice | null> {
    const invoice = (await this.storage.get<StoredInvoice>(invKey(memo))) ?? null;
    if (invoice) checkChain(chainId, invoice);
    return invoice;
  }

  async owner(chainId: number, txHash: string): Promise<string | null> {
    void chainId;
    return (await this.storage.get<string>(txKey(txHash))) ?? null;
  }

  async import(chainId: number, invoice: StoredInvoice): Promise<StoredInvoice> {
    checkChain(chainId, invoice);
    return await this.storage.transaction(async (txn) => {
      const existing = await txn.get<StoredInvoice>(invKey(invoice.memo));
      if (existing) return existing;
      await txn.put(invKey(invoice.memo), invoice);
      if (invoice.paid) {
        const owner = await txn.get<string>(txKey(invoice.paid.txHash));
        if (!owner) await txn.put(txKey(invoice.paid.txHash), invoice.memo);
      }
      return invoice;
    });
  }

  async create(chainId: number, invoice: StoredInvoice): Promise<CreateClaim> {
    checkChain(chainId, invoice);
    return await this.storage.transaction(async (txn) => {
      const existing = await txn.get<StoredInvoice>(invKey(invoice.memo));
      if (existing) return { status: "taken", invoice: existing };
      await txn.put(invKey(invoice.memo), invoice);
      return { status: "ok" };
    });
  }

  async pay(chainId: number, invoice: StoredInvoice, payment: Paid): Promise<PayClaim> {
    checkChain(chainId, invoice);
    return await this.storage.transaction(async (txn) => {
      const key = invKey(invoice.memo);
      const stored = (await txn.get<StoredInvoice>(key)) ?? invoice;
      checkChain(chainId, stored);
      if (stored.paid) {
        return stored.paid.txHash.toLowerCase() === payment.txHash.toLowerCase()
          ? { status: "paid", invoice: stored }
          : { status: "already_paid", invoice: stored };
      }
      const owner = await txn.get<string>(txKey(payment.txHash));
      if (owner && owner !== stored.memo) return { status: "tx_used", owner };
      const paid: StoredInvoice = { ...stored, paid: payment };
      await txn.put(key, paid);
      await txn.put(txKey(payment.txHash), stored.memo);
      return { status: "paid", invoice: paid };
    });
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return new Response("JSON body required", { status: 400 });
    }
    const chainId = Number(body.chainId);
    const invoice = body.invoice as StoredInvoice | undefined;
    switch (path) {
      case "/get":
        return Response.json(await this.get(chainId, String(body.memo)));
      case "/owner":
        return Response.json(await this.owner(chainId, String(body.txHash)));
      case "/import":
        return Response.json(await this.import(chainId, invoice!));
      case "/create":
        return Response.json(await this.create(chainId, invoice!));
      case "/pay":
        return Response.json(await this.pay(chainId, invoice!, body.payment as Paid));
      default:
        return new Response("not found", { status: 404 });
    }
  }
}

/** Calls one InvoiceStoreDO per chain. A failed store call throws, so a claim is never guessed. */
export class RemoteClaims implements InvoiceClaims {
  private readonly ns: DONamespace;
  private readonly chainId: number;

  constructor(ns: DONamespace, chainId: number) {
    this.ns = ns;
    this.chainId = chainId;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const stub = this.ns.get(this.ns.idFromName(`invoice-store:${this.chainId}`));
    const res = await stub.fetch(
      new Request(`https://invoice-store/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId: this.chainId, ...body }),
      }),
    );
    if (!res.ok) throw new Error(`Invoice store ${method} answered ${res.status}.`);
    return (await res.json()) as T;
  }

  get(chainId: number, memo: string): Promise<StoredInvoice | null> {
    return this.call("get", { chainId, memo });
  }

  owner(chainId: number, txHash: string): Promise<string | null> {
    return this.call("owner", { chainId, txHash });
  }

  import(chainId: number, invoice: StoredInvoice): Promise<StoredInvoice> {
    return this.call("import", { chainId, invoice });
  }

  create(chainId: number, invoice: StoredInvoice): Promise<CreateClaim> {
    return this.call("create", { chainId, invoice });
  }

  pay(chainId: number, invoice: StoredInvoice, payment: Paid): Promise<PayClaim> {
    return this.call("pay", { chainId, invoice, payment });
  }
}

export function claimsFor(ns: DONamespace | undefined, chainId: number): InvoiceClaims | undefined {
  return ns ? new RemoteClaims(ns, chainId) : undefined;
}
