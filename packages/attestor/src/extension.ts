import { randomBytes } from "node:crypto";
import type { ResourceServerExtension, VerifiedPaymentCanceledContext } from "@x402/core/types";
import { ALL_REFUSAL_REASONS, familyOf, httpStatusFor } from "./reasons.js";
import type { CoveragePolicy } from "./policy.js";
import { currentContext } from "./context.js";

export const REFUSAL_EXTENSION_KEY = "plimsoll.refusal";

/**
 * The x402 extension that makes the free refusal a stated term rather than an
 * accident of our error handling.
 *
 * It lives entirely on the resource server. The hosted Blocky402 facilitator
 * reports `extensions: []`, so anything requiring facilitator support is off
 * the table — and it does not need any: the declaration rides in the 402
 * challenge, and the enforcement is the middleware's own cancellation path.
 * The scheme stays plain `exact`, which is what keeps settlement qualifying
 * through the hosted facilitator.
 *
 * What a buyer learns before signing anything:
 *   - which outcomes cost money (exactly one: 200),
 *   - which do not, and what each of them means,
 *   - that a refusal is not a failed payment but a payment never requested.
 */
export function createRefusalExtension(policy: CoveragePolicy): ResourceServerExtension {
  return {
    key: REFUSAL_EXTENSION_KEY,
    // Regenerated per challenge, so the client is not asked to echo them back
    // verbatim under strict validation.
    dynamicInfoFields: ["challenge", "issuedAt"],

    /**
     * The returned object replaces `extensions[key]` on the wire rather than
     * merging into it, so the route's static terms have to be re-emitted here
     * alongside the per-challenge fields. Returning only the dynamic fields
     * would silently drop the refusal terms from the 402, which is the one
     * thing the buyer most needs to see before signing.
     */
    async enrichPaymentRequiredResponse(declaration: unknown) {
      const terms =
        declaration && typeof declaration === "object"
          ? (declaration as Record<string, unknown>)
          : refusalDeclaration(policy);
      return {
        ...terms,
        challenge: randomBytes(16).toString("hex"),
        issuedAt: Math.floor(Date.now() / 1000),
      };
    },

    hooks: {
      /**
       * Fires when the handler answered 4xx/5xx and the middleware cancelled
       * settlement. The Hedera `exact` server scheme declares no
       * `settleOnCancel`, and the `authorization` flow settles nothing before
       * the handler, so reaching this hook is proof that `settle` was never
       * called: the buyer's signed transfer was never submitted to a node and
       * will simply expire.
       *
       * Recording the cancellation here, rather than inferring it from a status
       * code in the handler, means the non-capture receipt is written from the
       * payment layer's own account of what happened.
       */
      async onVerifiedPaymentCanceled(
        _declaration: unknown,
        context: VerifiedPaymentCanceledContext,
      ) {
        const request = currentContext();
        if (!request) return;
        request.cancellation = {
          reason: context.reason,
          responseStatus: context.responseStatus,
        };
        // If this is ever non-empty the "nothing settled" claim is false, and
        // we would rather find out loudly in a log than ship a wrong receipt.
        if (context.settledPhases.length > 0) {
          console.error(
            `[attestor] cancellation reached with settled phases ${context.settledPhases.join(",")} ` +
              `for request ${request.requestId}; the no-charge claim cannot be trusted`,
          );
        }
      },
    },
  };
}

/** The static half of the declaration, attached to the route. */
export function refusalDeclaration(policy: CoveragePolicy): Record<string, unknown> {
  return {
    version: 1,
    paymentFlow: "authorization",
    chargedStatuses: [200],
    freeStatuses: [400, 402, 404, 422, 424, 500, 502],
    statement:
      "A refusal returns 4xx. The middleware cancels settlement before the facilitator is called, " +
      "so no transfer is ever submitted. There is no charge to refund and no transaction to void.",
    // There is no service-wide floor to advertise: each note is measured against
    // its own line in LoadLine, read alongside its readings.
    loadLine: "per note, read from LoadLine.lineOf(noteId) at the time of the reading",
    policyId: policy.id,
    families: {
      asset: {
        httpStatus: httpStatusFor("asset"),
        meaning: "Coverage was computed and the note does not clear.",
      },
      evidence: {
        httpStatus: httpStatusFor("evidence"),
        meaning: "No ratio was computed. This is a statement about our evidence, not the asset.",
      },
    },
    reasons: ALL_REFUSAL_REASONS.map((reason) => ({ reason, family: familyOf(reason) })),
  };
}
