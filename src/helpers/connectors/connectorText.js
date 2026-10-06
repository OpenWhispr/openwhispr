// Text helpers the connectors share, and the issue-tracker connectors'
// (GitHub, Linear) limits. The title and body limits are the card's
// (issueApprovalFields.ts): GitHub's, which Linear's exceed, so a card the
// user could send is never refused here for its length.
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 65536;
const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 10;
const SNIPPET_LENGTH = 300;

const LINE_BREAK = /[\r\n]/;

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// Characters (code points), as the card counts them.
function characterCount(text) {
  return [...text].length;
}

function clarify(message, candidates = []) {
  return { status: "needs_clarification", message, candidates };
}

module.exports = {
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_RESULTS,
  SNIPPET_LENGTH,
  LINE_BREAK,
  nonEmptyString,
  characterCount,
  clarify,
};
