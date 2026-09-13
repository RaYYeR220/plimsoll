import { auditRecords, notes, site } from '@/site.config';
import styles from '@/components/app/app.module.css';
import screens from '../screens.module.css';

/**
 * The topic is the attestation service's record, and every figure on it so far comes from
 * fixture backing — including the two records that name the real notes. The register says
 * so row by row, because a judge who opens the topic will find "PLIM-B attested, 150%" and
 * needs to know what that was before reading anything into it.
 */
export default function AuditPage() {
  const markets = notes.map((n) => n.market).join(' and ');

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>Audit trail</h1>
          <p className={styles.lede}>
            Every verdict the attestation service reaches — charged or refused — is written to a public Hedera topic in
            order. The topic has no admin key, so nobody can revise or delete what is on it, including us.
          </p>
        </div>
        <ul className={styles.rows}>
          <li>
            <span className="k">Topic</span>
            <span className="v">
              <a href={site.auditTopic.href}>{site.auditTopic.id}</a>
            </span>
          </li>
          <li>
            <span className="k">Admin key</span>
            <span className="v">None</span>
          </li>
          <li>
            <span className="k">Records shown</span>
            <span className="v">{auditRecords.length}</span>
          </li>
        </ul>
      </div>

      <section className={styles.panel} data-family="evidence">
        <h2>What these records are</h2>
        <p className={styles.panelNote}>
          Records 22 and 23 name {markets}, and they prove the path end to end on the real notes: the encoding, the
          signature, the charge on an attestation and the absence of one on a refusal. Their backing is not the notes’
          backing. Each says so itself — the feed is a fixture, the positions are invented, and the vault set is the
          placeholder that setVaultSet has since replaced. Records 17 to 19 are the service’s own test notes. The first
          reading of the notes’ registered vaults on Base will be a new record, and it will appear here.
        </p>
      </section>

      <section className={`${styles.panel} ${screens.gridTight}`}>
        <h2>The register</h2>
        <div className={screens.scroll}>
          <table className={screens.register}>
            <thead>
              <tr>
                <th scope="col">Seq</th>
                <th scope="col">Note</th>
                <th scope="col">Verdict</th>
                <th scope="col">Reading</th>
                <th scope="col">Backing</th>
                <th scope="col">Charged</th>
                <th scope="col">What the ledger shows</th>
              </tr>
            </thead>
            <tbody>
              {auditRecords.map((r) => (
                <tr key={r.seq}>
                  <td className="seq" data-label="Seq">
                    {r.seq}
                  </td>
                  <td data-label="Note">{r.note}</td>
                  <td data-label="Verdict">
                    <span
                      className={`${screens.tag} ${r.family ? '' : screens.tagQuiet}`}
                      data-family={r.family === 'evidence' ? 'evidence' : r.family ? 'asset' : 'covered'}
                    >
                      {r.decision}
                      {r.reason ? ` · ${r.reason}` : ''}
                    </span>
                  </td>
                  <td className="figure" data-label="Reading">
                    {r.bps === null ? (
                      'No figure'
                    ) : (
                      <>
                        {(r.bps / 100).toFixed(2)}%
                        <br />
                        {r.backing} against {r.obligation}
                      </>
                    )}
                  </td>
                  <td data-label="Backing">
                    {r.source}
                    {r.retiredVaultSet ? ', retired vault set' : ''}
                  </td>
                  <td data-label="Charged">
                    {r.charged && r.href ? (
                      <a href={r.href} title={r.settlement ?? undefined}>
                        Yes, on HashScan
                      </a>
                    ) : (
                      'No'
                    )}
                  </td>
                  <td data-label="Ledger">{r.proof}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.panelNote}>
          An evidence refusal carries no numeric field at all — not a zero. A reading of zero basis points would say
          zero-percent coverage, which is indistinguishable from a genuine finding of nothing, so absence is recorded
          as absence. That is also why a refusal with a figure prints both amounts: record 23 is 0.00%, and it is not an
          empty wallet.
        </p>
      </section>

      <div className={`${screens.grid} ${screens.gridTight}`}>
        <section className={styles.panel}>
          <h2>Check a record without asking us</h2>
          <p className={styles.panelNote}>
            The verifier needs no key, no account and no access to our infrastructure. It re-reads the anchored evidence
            from the public mirror node, recomputes the ratio with its own arithmetic, asks the ledger what moved, and
            prints a verdict.
          </p>
          <p className={screens.command}>node dist/bin/verify-charge.js --hcs {site.auditTopic.id}:18 --explain</p>
          <ul className={styles.rows}>
            <li>
              <span className="k">Charged and warranted</span>
              <span className="v">exit 0</span>
            </li>
            <li>
              <span className="k">Refused and not charged</span>
              <span className="v">exit 0</span>
            </li>
            <li>
              <span className="k">A charge nobody will sign for</span>
              <span className="v">exit 2</span>
              <span className="sub">
                Every credit in the window is matched against the records on the topic. A credit no record claims is the
                discrepancy.
              </span>
            </li>
            <li>
              <span className="k">Nothing to evaluate</span>
              <span className="v">exit 3</span>
              <span className="sub">Never reported as a verdict.</span>
            </li>
          </ul>
        </section>

        <section className={styles.panel}>
          <h2>What one record carries</h2>
          <p className={styles.panelNote}>
            Each verdict is a single message under the 1,024-byte limit, so it never chunks into pieces nobody
            reassembles. It holds the whole input set: the positions, the raw readings, the block, the source set, the
            floor, the ratio, the policy, the full signature, and whether a charge occurred.
          </p>
          <ul className={styles.rows}>
            <li>
              <span className="k">Encoding</span>
              <span className="v">v3 from record 22</span>
              <span className="sub">
                The version selects the verification rules, so a record is always checked under the rules it was written
                with. Version 3 also names the feed and the oracle it reports to, which is how records 22 and 23 declare
                their fixture backing.
              </span>
            </li>
            <li>
              <span className="k">Evidence refusals</span>
              <span className="v">no numbers</span>
            </li>
            <li>
              <span className="k">Earlier records</span>
              <span className="v">Seq 1 to 21</span>
              <span className="sub">
                Written under the first two encodings and left exactly where they are. The topic cannot be revised, which
                is the property that makes it worth reading.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
