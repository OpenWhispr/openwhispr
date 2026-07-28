// After /^(0|[1-9]\d{0,2})$/, can Number(part) ever be a non-integer or negative?
const re = /^(0|[1-9]\d{0,2})$/;
let nonInt = 0, neg = 0, over = 0, n = 0;
for (let i = 0; i < 1000; i++) {
  const s = String(i);
  if (!re.test(s)) continue;
  n++;
  const v = Number(s);
  if (!Number.isInteger(v)) nonInt++;
  if (v < 0) neg++;
  if (v > 255) over++;
}
console.log({ matched: n, nonInteger: nonInt, negative: neg, over255: over });
