/**
 * The tax port guard (Phase 1.2, extended in Phase 1.6) — SERVER ONLY.
 *
 * One wrapper, applied to **every** adapter, so an incoherent answer never
 * reaches a buyer's card. The rules live in the contract; this is where they are
 * enforced — once, for every engine, so a future vendor adapter cannot forget to
 * apply one.
 *
 * Extracted from `tax-adapters.ts` in `1.6` so the Stripe Tax adapter can be
 * held to the identical checks without the two modules importing each other.
 *
 * What it refuses, and what each refusal actually prevents:
 *
 * | Refusal | What it stops |
 * | --- | --- |
 * | incoherent quote | tax charged under a treatment that says none is due, or tax exceeding its own basis |
 * | currency mismatch | a rate computed in one currency charged in another |
 * | basis mismatch | an engine assessing a sale other than the one asked about |
 * | Product-basis mismatch | a rate computed for a different Product, or a different immutable version of it |
 * | already expired | a calculation the provider will no longer honour, and cannot later reverse |
 * | incomplete production quote | a real sale whose tax basis cannot be interpreted after a mapping change |
 */

import "../server-only";
import {
  TaxCalculationRequest,
  TaxQuote,
  productionTaxQuoteIssues,
  taxQuoteIsCoherent,
  taxQuoteIsUsableAt,
  type TaxCalculationPort,
} from "../../contracts/marketplace/tax-calculation";
import {
  IncoherentTaxQuoteError,
  TaxProductBasisMismatchError,
  TaxProviderConfigurationError,
  TaxQuoteExpiredError,
} from "./tax-errors";

/**
 * Wrap an adapter so an incoherent answer never reaches a buyer's card.
 *
 * Exported so a test exercises the real guard rather than a copy of its rules —
 * a duplicated guard in a test proves only that the copy works.
 */
export function guardTaxPort(port: TaxCalculationPort): TaxCalculationPort {
  return {
    async calculate(rawRequest) {
      const request = TaxCalculationRequest.parse(rawRequest);
      const quote = TaxQuote.parse(await port.calculate(request));

      if (!taxQuoteIsCoherent(quote)) throw new IncoherentTaxQuoteError();
      if (quote.currency !== request.currency) throw new IncoherentTaxQuoteError();

      /* The engine must have assessed the sale Monacado asked about. A basis it
         invented is a basis nobody can reconcile against the Order. */
      const expectedBasis =
        request.commercialRetailAmountMinorUnits + request.shippingAmountMinorUnits;
      if (quote.basisAmountMinorUnits !== expectedBasis) throw new IncoherentTaxQuoteError();

      /* — Phase 1.6 —
       *
       * The quote must name the EXACT Product basis it was asked about. An engine
       * that answered about a different Product, or a different immutable version
       * of it, is answering about a different sale — and a quote that simply
       * omitted the basis would leave a completed sale unable to say what
       * classification produced its rate. */
      if (request.product !== null) {
        if (quote.productTaxBasis === null) {
          throw new TaxProductBasisMismatchError(["productTaxBasis"]);
        }
        const mismatched: string[] = [];
        const expected = request.product;
        const actual = quote.productTaxBasis;
        if (actual.internalProductId !== expected.internalProductId) {
          mismatched.push("internalProductId");
        }
        if (actual.sourceRecordId !== expected.sourceRecordId) mismatched.push("sourceRecordId");
        if (actual.sourceRecordVersion !== expected.sourceRecordVersion) {
          mismatched.push("sourceRecordVersion");
        }
        if (actual.taxClassification !== expected.taxClassification) {
          mismatched.push("taxClassification");
        }
        if (actual.deliveryMode !== expected.deliveryMode) mismatched.push("deliveryMode");
        if (mismatched.length > 0) throw new TaxProductBasisMismatchError(mismatched);
      }

      /* An engine that hands back an already-expired calculation has handed back
         something Monacado cannot charge on and could not later reverse. */
      if (!taxQuoteIsUsableAt(quote, request.at)) throw new TaxQuoteExpiredError();

      /* A production answer must carry what makes it interpretable years later.
         A test adapter is exempt: it governs no commerce. */
      const incomplete = productionTaxQuoteIssues(quote);
      if (incomplete.length > 0) throw new TaxProviderConfigurationError(incomplete);

      return quote;
    },
  };
}
