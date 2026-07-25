/**
 * Authority roles (ANS §2; ADR §11).
 *
 * Kept distinct, and never conflated:
 *   - Factual / source authority — the creator, whose claims the Product data
 *     asserts. Expressed in provenance/source-record terms and the creator
 *     relationship; NOT published as a competing `sourceAuthority` field.
 *   - Publisher — the ANS role that submits the capsule. In this walled-garden
 *     model the Publisher is Monacado (a fixed platform identity).
 *   - Capsule generator — the operational component that builds a candidate. It
 *     holds no authority and MUST NOT be substituted for the Publisher.
 *
 * ANS: generation/registration never confer factual authority; a Publisher "MAY
 * delegate operational tasks without delegating authority."
 */

/** The sole walled-garden Publisher identity (Monacado). Provisional synthetic value. */
export const MONACADO_PUBLISHER_ID = "an:publisher:monacado-platform" as const;

/** The capsule generator identity — operational only; never a Publisher. */
export const CAPSULE_GENERATOR_ID = "an:generator:monacado-contracts" as const;

/** Current generator version stamped into provenance. */
export const GENERATOR_VERSION = "0b1.0.0" as const;

export class ProductPublisherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductPublisherError";
  }
}

/**
 * Assert that a proposed `publishedBy` is the Monacado Publisher, not a
 * generator or other identity. Prevents a generator from substituting for the
 * Publisher (ANS §2).
 */
export function assertMonacadoPublisher(publishedBy: string): void {
  if (publishedBy === CAPSULE_GENERATOR_ID) {
    throw new ProductPublisherError(
      "The capsule generator identity cannot act as the ANS Publisher.",
    );
  }
  if (publishedBy !== MONACADO_PUBLISHER_ID) {
    throw new ProductPublisherError(
      `Publisher must be the Monacado Publisher (${MONACADO_PUBLISHER_ID}); got "${publishedBy}".`,
    );
  }
}
