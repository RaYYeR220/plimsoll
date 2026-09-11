/**
 * Every address this app links to is resolved here. When something is redeployed or
 * re-run, this is the only file that changes — and most of it reads the records the other
 * packages already keep, so a re-run usually needs no edit at all.
 *
 * Read on the server only: the pages hand client components the few values they need, so
 * the deployment records never ship to the browser.
 *
 * Contract addresses are deliberately not shown on the landing. They are listed in PROOF.md.
 */

import deployment from '../../packages/contracts/deployments/hedera-testnet.json';
import deviceProof from '../../packages/contracts/deployments/device-proof.json';
import notesFile from '../../packages/substreams/notes.json';
import type { LifecycleStep, NoteRecord, VaultLeg } from './lib/notes';

const repo = 'https://github.com/RaYYeR220/plimsoll';
const hashscan = 'https://hashscan.io/testnet';
const basescan = 'https://basescan.org';

/** A HashScan link for a transaction, from an EVM hash or a Hedera transaction id. */
export const txUrl = (id: string): string =>
  `${hashscan}/transaction/${id.startsWith('0x') ? id : id.replace('@', '-').replace(/\.(\d+)$/, '-$1')}`;

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/* ── the device sequence ─────────────────────────────────────────────────
   Steps are matched by the call they record, not by position, so a re-run that
   adds or reorders steps still resolves. A missing step leaves the sequence
   unlinked rather than half-linked. */
type Step = { call?: unknown; status?: unknown; tx?: unknown };
const steps: Step[] = Array.isArray((deviceProof as { steps?: unknown }).steps)
  ? (deviceProof as { steps: Step[] }).steps
  : [];
const stepTx = (call: string, status: string): string | null => {
  const step = steps.find((s) => s.call === call && s.status === status);
  return typeof step?.tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(step.tx) ? step.tx : null;
};
const halt = stepTx('LoadLine.halt', 'SUCCESS');
const refusedResume = stepTx('LoadLine.resume', 'REVERTED');
const resume = stepTx('LoadLine.resume', 'SUCCESS');

export type DeviceLinks = { halt: string; refusedResume: string; resume: string };

const denial = deployment.denial_artifact;
const ATTESTED_PAYMENT = '0.0.7162784@1789121899.540907773';

/* ── the notes ───────────────────────────────────────────────────────────
   Identity, obligation and lifecycle come from the deployment record; the vault
   set and the negative-control flag from the shared notes file. */

const noteB = deployment.ats.notes['PLIM-B'];
const noteA = deployment.ats.issuedNote;
const defs = notesFile.notes as Record<string, { market: string; vaults: string[]; negativeControl: boolean }>;
const defOf = (market: string) => Object.values(defs).find((d) => d.market === market);

/**
 * The Base vaults each note's backing plan names, mirrored from
 * packages/backing/src/config.ts. That file is TypeScript rather than JSON, so it cannot be
 * imported here; when it is emitted as a record this block should read it instead.
 * The deposits are planned, not recorded as made, and every screen says so.
 */
const PLAN: Record<string, readonly VaultLeg[]> = {
  'PLIM-B': [
    leg('morpho', 'Gauntlet USDC Prime', 'Morpho (MetaMorpho)', '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61', 'USDC', 8),
    leg('aave', 'Wrapped Aave Base USDC', 'Aave v3 static aToken', '0xC768c589647798a6EE01A91FdE98EF2ed046DBD6', 'USDC', 4),
    leg('spark', 'Spark USDC Vault', 'Spark (PSM3)', '0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858', 'USDC', 'rest'),
  ],
  'PLIM-A': [
    leg('moonwell-eth', 'Moonwell Flagship ETH', 'Morpho, curated for Moonwell', '0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1', 'WETH', 0.0004),
  ],
};

function leg(
  key: string,
  name: string,
  protocol: string,
  address: string,
  asset: string,
  planned: number | 'rest',
): VaultLeg {
  return { key, name, protocol, address, asset, planned, href: `${basescan}/address/${address}` };
}

const LIFECYCLE_LABEL: Record<string, string> = {
  addIssuer: 'Issuer role granted',
  grantKyc: 'Holder cleared for KYC',
  issueByPartition: 'Notes issued',
};

function lifecycleOf(raw: ReadonlyArray<{ step: string; tx: string; result: string }>): LifecycleStep[] {
  const seen = new Map<string, number>();
  return raw.map((s) => {
    const n = (seen.get(s.step) ?? 0) + 1;
    seen.set(s.step, n);
    const base = LIFECYCLE_LABEL[s.step] ?? s.step;
    return {
      step: n > 1 ? `${base} (${n})` : base,
      tx: s.tx,
      href: txUrl(s.tx),
      result: s.result,
    };
  });
}

const plimB: NoteRecord = {
  market: noteB.symbol,
  name: noteB.name,
  isin: noteB.isin,
  hederaId: noteB.hederaId,
  address: noteB.address,
  href: noteB.hashscan,
  noteId: noteB.noteId,
  obligation: {
    units: noteB.obligation.totalSupplyBaseUnits,
    decimals: noteB.obligation.tokenDecimals,
    nominalValue: noteB.obligation.nominalValue,
    nominalValueDecimals: noteB.obligation.nominalValueDecimals,
    currency: 'USD',
  },
  thresholdBps: noteB.registration.loadLine.loadLineBps,
  thresholdMandate: { tx: noteB.registration.loadLine.tx, href: noteB.registration.loadLine.hashscan },
  negativeControl: defOf('PLIM-B')?.negativeControl ?? false,
  nominatedVaults: defOf('PLIM-B')?.vaults ?? [],
  vaultSetSettled: (defOf('PLIM-B')?.vaults ?? []).length > 0,
  plan: PLAN['PLIM-B'],
  lifecycle: [
    ...lifecycleOf(noteB.lifecycle),
    {
      step: 'Load line set on the device',
      tx: noteB.registration.loadLine.tx,
      href: noteB.registration.loadLine.hashscan,
      result: 'SUCCESS',
    },
    {
      step: 'Escrow allowance approved',
      tx: noteB.listing.approval.tx,
      href: noteB.listing.approval.hashscan,
      result: noteB.listing.approval.result,
    },
  ],
  listing: { status: noteB.listing.status, why: noteB.listing.whyNotPlaced },
  note: 'The right-sized series: a $10.00 obligation against Base backing, so it is the note that should clear.',
};

const plimA: NoteRecord = {
  market: noteA.symbol,
  name: noteA.name,
  isin: noteA.isin,
  hederaId: noteA.hederaId,
  address: noteA.address,
  href: noteA.hashscan,
  noteId: deployment.note_under_management.noteId,
  /* Read from the note on 2026-09-12: totalSupply() 1,000,000 at decimals() 2, nominal
     value 100.00. The deployment record carries no obligation block for PLIM-A yet. */
  obligation: { units: 1_000_000, decimals: 2, nominalValue: 10_000, nominalValueDecimals: 2, currency: 'USD' },
  thresholdBps: 10_000,
  thresholdMandate: null,
  negativeControl: defOf('PLIM-A')?.negativeControl ?? true,
  nominatedVaults: defOf('PLIM-A')?.vaults ?? [],
  vaultSetSettled: (defOf('PLIM-A')?.vaults ?? []).length > 0,
  plan: PLAN['PLIM-A'],
  lifecycle: [],
  listing: {
    status: 'not listed',
    why: 'The negative control is never meant to clear: a $1,000,000 obligation against about $15 of backing.',
  },
  note: 'The negative control. It must always refuse, and a clean result on the other note is worth nothing without it.',
};

export const notes: readonly NoteRecord[] = [plimB, plimA];
export const noteBySlug = (slug: string): NoteRecord | undefined =>
  notes.find((n) => n.market.toLowerCase() === slug.toLowerCase());

export const site = {
  appHref: '/app',
  repo,
  proofDoc: `${repo}/blob/main/PROOF.md`,
  licence: `${repo}/blob/main/LICENSE`,

  /** A transfer of PLIM-A to a blocked address, reverted by the note: AccountIsBlocked. */
  denial: {
    hash: denial.tx,
    href: txUrl(denial.tx),
    subject: shortAddress(denial.blockedCounterparty),
    status: denial.status,
    decoded: 'AccountIsBlocked',
  },

  /** The note the landing points at. */
  note: {
    id: '0.0.10451856',
    href: `${hashscan}/contract/0.0.10451856`,
  },

  /** The HCS topic every attestation and refusal is written to. It has no admin key. */
  auditTopic: {
    id: '0.0.10451091',
    href: `${hashscan}/topic/0.0.10451091`,
  },

  /** Canonical records on the audit topic, in the current encoding. */
  records: {
    attested: 17,
    refusedShort: 18,
    refusedUnproven: 19,
  },

  /** The settlement that paid for record 17. */
  attestedPayment: {
    id: ATTESTED_PAYMENT,
    href: txUrl(ATTESTED_PAYMENT),
  },

  harnessPr: {
    id: 'hedera-harness #55',
    href: 'https://github.com/hedera-dev/hedera-harness/pull/55',
  },

  device:
    halt && refusedResume && resume
      ? ({ halt: txUrl(halt), refusedResume: txUrl(refusedResume), resume: txUrl(resume) } satisfies DeviceLinks)
      : null,

  /** What the venue asks the note before it books anything, read from the deployment record. */
  venue: {
    preflight: deployment.preflight_evidence.call,
    blocked: deployment.preflight_evidence.toBlockedCounterparty,
    allowed: deployment.preflight_evidence.toAllowedCounterparty,
  },

  holder: '0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a',
  holderHref: `${basescan}/address/0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a`,
} as const;
