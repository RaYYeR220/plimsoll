import { notFound } from 'next/navigation';
import { NoteHero } from '@/components/app/NoteHero';
import {
  formatAmount,
  formatUsd,
  notesOutstanding,
  obligationValue,
  parPerNote,
  type CoverageState,
} from '@/lib/coverage-state';
import { noteBySlug, notes, site } from '@/site.config';
import styles from '@/components/app/app.module.css';
import note from './note.module.css';

export function generateStaticParams() {
  return notes.map((n) => ({ market: n.market.toLowerCase() }));
}

export default async function NotePage({ params }: { params: Promise<{ market: string }> }) {
  const { market } = await params;
  const record = noteBySlug(market);
  if (!record) notFound();

  const owed = obligationValue(record.obligation);
  const recorded: CoverageState = { family: 'evidence', reason: 'no-reading-yet' };
  const recordedWords = record.vaultSetSettled
    ? 'The note has no attestation on record yet.'
    : 'No position reading yet: the vault set is still being settled, so nothing can attest this note.';

  const plannedKnown = record.plan.filter((l) => typeof l.planned === 'number');
  const plannedTotal = plannedKnown.reduce((sum, l) => sum + (l.planned as number), 0);
  const widest = Math.max(...plannedKnown.map((l) => l.planned as number), 1);

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>{record.market}</h1>
          <p className={styles.lede}>
            {record.name}. {record.note}
          </p>
        </div>
        <ul className={styles.rows}>
          <li>
            <span className="k">ISIN</span>
            <span className="v">{record.isin}</span>
          </li>
          <li>
            <span className="k">Hedera</span>
            <span className="v">
              <a href={record.href}>{record.hederaId}</a>
            </span>
          </li>
          <li>
            <span className="k">Load line</span>
            <span className="v">{(record.thresholdBps / 100).toFixed(2)}%</span>
          </li>
        </ul>
      </div>

      <NoteHero obligation={record.obligation} recorded={recorded} demonstrated={recordedWords} />

      <div className={note.grid}>
        <section className={styles.panel}>
          <h2>What the note owes</h2>
          <ul className={styles.rows}>
            <li>
              <span className="k">totalSupply()</span>
              <span className="v">{record.obligation.units.toLocaleString('en-US')} base units</span>
            </li>
            <li>
              <span className="k">decimals()</span>
              <span className="v">{record.obligation.decimals}</span>
            </li>
            <li>
              <span className="k">Notes outstanding</span>
              <span className="v">{formatAmount(notesOutstanding(record.obligation))}</span>
            </li>
            <li>
              <span className="k">getNominalValue()</span>
              <span className="v">{formatUsd(parPerNote(record.obligation))} a note</span>
            </li>
            <li>
              <span className="k">Obligation</span>
              <span className="v">{formatUsd(owed)}</span>
            </li>
          </ul>
          <p className={styles.panelNote}>
            The denominator of every ratio on this screen is read from the note itself — supply times nominal value —
            and never taken from configuration.
          </p>
        </section>

        <section className={styles.panel}>
          <h2>Backing by vault</h2>
          <ul className={styles.legs}>
            {record.plan.map((l) => (
              <li key={l.key} className={styles.leg}>
                <span className={styles.legName}>
                  <a href={l.href}>{l.name}</a>
                  <small>
                    {l.protocol} · {l.asset}
                  </small>
                </span>
                <span className={styles.legAmount}>
                  {typeof l.planned === 'number' ? formatUsd(l.planned) : 'remainder'}
                </span>
                <span className={styles.legBar}>
                  {typeof l.planned === 'number' ? (
                    <i style={{ width: `${Math.min(100, (l.planned / widest) * 100)}%` }} />
                  ) : (
                    <em className={note.rest} />
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.panelNote}>
            Nominated on Base, held by <a href={site.holderHref}>the issuer's own address</a>. These are the planned
            deposits, not a reading: until the set is final and the first reading lands, this note has no coverage
            figure at all. {plannedKnown.length > 0 && `Named legs come to ${formatUsd(plannedTotal)}.`}
          </p>
        </section>

        <section className={styles.panel}>
          <h2>The line, and who moved it</h2>
          <ul className={styles.rows}>
            <li>
              <span className="k">Threshold</span>
              <span className="v">{(record.thresholdBps / 100).toFixed(2)}%</span>
            </li>
            {record.thresholdMandate && (
              <li>
                <span className="k">Approved on the device</span>
                <span className="v">
                  <a href={record.thresholdMandate.href}>SET-THRESHOLD</a>
                </span>
                <span className="sub">
                  A person read the action, the market, the coverage and the new line on a Ledger, and approved it.
                  Without that signature the call reverts.
                </span>
              </li>
            )}
            <li>
              <span className="k">Listing</span>
              <span className="v">{record.listing.status}</span>
              <span className="sub">{record.listing.why}</span>
            </li>
          </ul>
        </section>

        <section className={styles.panel}>
          <h2>Attestation</h2>
          <ul className={styles.rows}>
            <li>
              <span className="k">Records for this note</span>
              <span className="v">None</span>
              <span className="sub">{recordedWords}</span>
            </li>
            <li>
              <span className="k">Audit topic</span>
              <span className="v">
                <a href={site.auditTopic.href}>{site.auditTopic.id}</a>
              </span>
              <span className="sub">
                The topic carries the attestation service's own records, against its test notes rather than this one.
                Nothing on it is evidence about {record.market}.
              </span>
            </li>
          </ul>
          <p className={styles.panelNote}>
            An attestation is refused rather than guessed. Until the vaults can be read, the honest answer is that
            there is no figure — which is why this screen shows none.
          </p>
        </section>

        {record.lifecycle.length > 0 && (
          <section className={`${styles.panel} ${note.wide}`}>
            <h2>Provenance</h2>
            <ul className={styles.rows}>
              {record.lifecycle.map((s) => (
                <li key={s.tx}>
                  <span className="k">{s.step}</span>
                  <span className="v">
                    <a href={s.href}>{s.result}</a>
                  </span>
                </li>
              ))}
            </ul>
            <p className={styles.panelNote}>
              Every line is a transaction on Hedera testnet, in the order it happened.
            </p>
          </section>
        )}
      </div>
    </>
  );
}
