import { deviceInfo, deviceTranscript, notes, thresholdMandate } from '@/site.config';
import styles from '@/components/app/app.module.css';
import screens from '../screens.module.css';

/**
 * What an issuer can do, and what it costs them to do it: a person, a device, and a
 * mandate they can read. The transcript below is the deployment record, not a retelling.
 */
export default function IssuerPage() {
  const plimB = notes[0];
  const outcome = (entry: (typeof deviceTranscript)[number]) => {
    if (entry.kind === 'mandate') return entry.approved ? 'approved' : 'refused';
    if (entry.kind === 'call') return entry.status === 'SUCCESS' ? 'success' : 'reverted';
    return 'state';
  };

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>Issuer console</h1>
          <p className={styles.lede}>
            Moving a note's line and halting its market both take a mandate a person approved on a Ledger. Decline it
            and the device answers 6985 with no signature at all.
          </p>
        </div>
      </div>

      <div className={screens.split}>
        <section className={styles.panel}>
          <h2>The mandate {plimB.market} was opened with</h2>
          <p className={styles.panelNote}>
            The contract never parses this string. It rebuilds it from typed arguments plus its own address and chain
            id, so the only string that verifies is the one it would have written itself.
          </p>
          <pre className={screens.mandate}>{thresholdMandate.mandateText}</pre>
          <ul className={styles.rows}>
            <li>
              <span className="k">Load line set</span>
              <span className="v">{(thresholdMandate.loadLineBps / 100).toFixed(2)}%</span>
            </li>
            <li>
              <span className="k">Nonce</span>
              <span className="v">{thresholdMandate.nonce}</span>
              <span className="sub">Single use: the same approval cannot be replayed.</span>
            </li>
            <li>
              <span className="k">Executed</span>
              <span className="v">
                <a href={thresholdMandate.href}>SET-THRESHOLD</a>
              </span>
            </li>
          </ul>
        </section>

        <section className={styles.panel}>
          <h2>What the device showed</h2>
          <p className={styles.panelNote}>
            Paged exactly as the firmware paged it. The device reflows newlines into spaces and wraps at about nineteen
            characters, so no value may contain a space or a colon — otherwise a market code could impersonate a second
            field and the person would have no way to tell.
          </p>
          <ol className={screens.screens}>
            {thresholdMandate.screens.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </section>
      </div>

      <div className={`${screens.grid} ${screens.gridTight}`}>
        <section className={`${styles.panel} ${screens.wide}`}>
          <h2>A halt, a refusal, and two wrong doors</h2>
          <p className={styles.panelNote}>
            Recorded against {deviceInfo.market} on Hedera testnet. The same signed mandate was sent to the verifier and
            to the adapter directly: both refused it, and the approval was still unspent afterwards, so it worked when it
            finally went through the load line. Then the device declined a resume, and the market stayed halted.
          </p>
          <ul className={screens.steps}>
            {deviceTranscript.map((entry, i) => (
              <li className={screens.step} key={`${entry.kind}-${i}`} data-outcome={outcome(entry)}>
                <span className={screens.stepLabel}>{entry.label}</span>
                {entry.kind === 'mandate' && (
                  <>
                    <span className={screens.stepResult}>{entry.decision}</span>
                    <span className={screens.stepMeta}>
                      {entry.action} · nonce {entry.nonce}
                      {entry.approved ? '' : ' · 6985, no signature exists'}
                    </span>
                  </>
                )}
                {entry.kind === 'call' && (
                  <>
                    <span className={screens.stepResult}>
                      <a href={entry.href}>{entry.status}</a>
                    </span>
                    <span className={screens.stepMeta}>
                      {entry.call}
                      {entry.error ? ` · ${entry.error}` : ''}
                    </span>
                  </>
                )}
                {entry.kind === 'state' && (
                  <>
                    <span className={screens.stepResult}>{entry.halted ? 'Halted' : 'Trading'}</span>
                    {entry.loadLineBps !== null && (
                      <span className={screens.stepMeta}>Load line {(entry.loadLineBps / 100).toFixed(2)}%</span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.panel}>
          <h2>The device that holds the authority</h2>
          <ul className={styles.rows}>
            <li>
              <span className="k">Application</span>
              <span className="v">{deviceInfo.app}</span>
            </li>
            <li>
              <span className="k">Model</span>
              <span className="v">{deviceInfo.model}</span>
            </li>
            <li>
              <span className="k">Running on</span>
              <span className="v">{deviceInfo.emulator}</span>
              <span className="sub">
                An emulator running the real Ethereum application, on a seed held outside the repository. On hardware
                the key would additionally be non-extractable; that is a property of the hardware, not of anything shown
                here.
              </span>
            </li>
          </ul>
        </section>

        <section className={styles.panel}>
          <h2>What the device does not govern</h2>
          <ul className={styles.rows}>
            <li>
              <span className="k">Deployment administration</span>
              <span className="v">Owner</span>
              <span className="sub">
                Wiring the oracle, registering notes, rotating an attestor and creating schedules are owner-gated. A
                mandate is only worth something if a person can read what they are approving, and raw hex on a
                four-line screen is a rubber stamp with extra steps.
              </span>
            </li>
            <li>
              <span className="k">The authority itself</span>
              <span className="v">Owner</span>
              <span className="sub">
                The owner can repoint it, so the accurate claim is that the device approves load-line changes — not
                that nobody can bypass the device.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
