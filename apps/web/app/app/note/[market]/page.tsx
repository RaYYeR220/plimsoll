import { notFound } from 'next/navigation';
import { NoteHero } from '@/components/app/NoteHero';
import { formatAmount, formatUsd, notesOutstanding, obligationValue, parPerNote } from '@/lib/coverage-state';
import { auditRecords, noteBySlug, notes, site } from '@/site.config';
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
  const readOn = record.oracle.readOn;
  const setWords = record.vaultSetSettled
    ? `The vault set is registered, and when the oracle was read on ${readOn} the holder on Base was not funded yet.`
    : 'The vault set is not final yet.';
  const recordedWords =
    record.oracle.reason === 'AttestationExpired'
      ? `CoverageOracle reads ${record.market} as unproven: its last attestation has expired. ${setWords}`
      : `CoverageOracle holds no attestation for ${record.market}. ${setWords}`;

  const ownRecords = auditRecords.filter((r) => record.recordSeqs.includes(r.seq));
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

      <NoteHero
        obligation={record.obligation}
        recorded={record.recorded}
        demonstrated={recordedWords}
        negativeControl={record.negativeControl}
        plannedBackingUsd={record.plannedBackingUsd}
      />

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
            On Base, held by <a href={site.holderHref}>the issuer's own address</a>.{' '}
            {record.vaultSetSettled
              ? 'The vault set is registered on CoverageOracle, and the two notes’ sets are disjoint: a position backs exactly one note.'
              : 'The two notes’ sets are disjoint: a position backs exactly one note.'}{' '}
            The amounts are planned deposits, not a reading, so this note has no coverage figure until the holder is
            funded and the first reading lands.{' '}
            {plannedKnown.length > 0 && `Named legs come to ${formatUsd(plannedTotal)}.`}
          </p>
        </section>

        {record.scenario && (
          <section className={styles.panel}>
            <h2>What the plan does when it is tested</h2>
            <ul className={styles.rows}>
              {record.scenario.map((s) => (
                <li key={s.label}>
                  <span className="k">{s.label}</span>
                  <span className="v">
                    {s.coverage} · {s.clear ? 'clear' : 'refused'}
                  </span>
                  <span className="sub">{s.detail}</span>
                </li>
              ))}
            </ul>
            <p className={styles.panelNote}>
              Measured on a fork of Base, not on funded positions. It is the case for a line drawn against value: the
              market stops when what is behind the note is worth too little, whatever it is spread across.
            </p>
          </section>
        )}

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
              <span className="k">CoverageOracle, read {readOn}</span>
              <span className="v">
                {record.oracle.verdict} · {record.oracle.reason}
              </span>
              <span className="sub">{recordedWords}</span>
            </li>
            {ownRecords.map((r) => (
              <li key={r.seq}>
                <span className="k">
                  <a href={site.auditTopic.href}>Record {r.seq}</a>
                </span>
                <span className="v">
                  {r.decision}
                  {r.bps !== null ? ` · ${(r.bps / 100).toFixed(2)}%` : ''}
                </span>
                <span className="sub">
                  {r.backing} against {r.obligation}, computed from fixture backing ({r.source})
                  {r.retiredVaultSet ? ' against the vault set that has since been replaced' : ''}. It proves the path on
                  this note, not this note’s backing.
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.panelNote}>
            A figure from fixture backing is never shown as this note’s coverage, and a lapsed attestation counts for
            nothing. The first reading of the registered vaults will be a new record on the topic.
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
