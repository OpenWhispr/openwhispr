// Raw error messages can carry URLs, tokens or response text (network errors
// quote the request URL), so connector logs record only these two fields.
function describeError(error) {
  let errorCode = null;
  if (typeof error?.code === "string") errorCode = error.code;
  else if (typeof error?.cause?.code === "string") errorCode = error.cause.code;
  else if (typeof error?.redirectCode === "string") errorCode = error.redirectCode;
  return { errorName: typeof error?.name === "string" ? error.name : "Error", errorCode };
}

module.exports = { describeError };
