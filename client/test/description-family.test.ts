import test from "node:test";
import assert from "node:assert/strict";

import { descriptionFamily } from "../src/description-family.ts";

test("merchant families ignore store and transaction identifiers", () => {
  assert.equal(descriptionFamily("UNITED DAIRY FARMERS 639 DELAWARE OH").key,
    descriptionFamily("UNITED DAIRY FARMERS 812 COLUMBUS OH").key);
  assert.equal(descriptionFamily("CHICK-FIL-A #01539 GROVE CITY OH; reference 62142498").key,
    descriptionFamily("CHICK-FIL-A #05488 LEWIS CENTER OH; reference 62143785").key);
  assert.equal(descriptionFamily("AMAZON MKTPL*515WD1JG0 SEATTLE WA").key,
    descriptionFamily("AMAZON MKTPL*5R7QA06F0 SEATTLE WA").key);
});

test("meaningful Amazon product prefixes remain separate", () => {
  const marketplace = descriptionFamily("AMAZON MKTPL*515WD1JG0 SEATTLE WA").key;
  assert.notEqual(marketplace, descriptionFamily("AMAZON PRIME*0W39D5DW3 SEATTLE WA").key);
  assert.notEqual(marketplace, descriptionFamily("AMAZON RETA*5A4GI7220 SEATTLE WA").key);
  assert.notEqual(marketplace, descriptionFamily("AMAZON DIGI* 5197L9E70 SEATTLE WA").key);
});

test("interest-charge variants share one likely destination-account family", () => {
  const purchases = descriptionFamily("Interest Charge on Purchases").key;
  assert.equal(purchases, descriptionFamily("INTEREST CHARGE-CURRENT PURCHASES").key);
  assert.equal(purchases, descriptionFamily("Interest Charge on Cash Advances").key);
  assert.equal(purchases, descriptionFamily("Interest Charge on Balance Transfers").key);
});

test("timestamps and variable amounts do not split crypto action families", () => {
  const first = descriptionFamily("2026-08-26 17:47:31 UTC; Sell BTC. Price currency USD; price at transaction $78401.73").key;
  const second = descriptionFamily("2026-09-16 12:13:33 UTC; Sell BTC. Price currency USD; price at transaction $76060.80").key;
  assert.equal(first, second);
  assert.notEqual(first,
    descriptionFamily("2026-09-16 04:21:54 UTC; Receive BTC. Price currency USD; subtotal $1062.57").key);
});
