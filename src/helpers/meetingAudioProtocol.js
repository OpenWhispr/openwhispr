const fs = require("fs");
const { Readable } = require("stream");
function rangeFor(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < size
    ? { start, end, partial: true }
    : null;
}
function createAudioHandler(storage, noteExists) {
  return async (request) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.hostname !== "recording") return new Response(null, { status: 404 });
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 3) return new Response(null, { status: 404 });
      const [note, id, source] = parts;
      const noteId = Number(note);
      if (!Number.isSafeInteger(noteId) || !noteExists(noteId))
        return new Response(null, { status: 404 });
      const file = storage().resolveTrack(noteId, id, source);
      const size = fs.statSync(file).size;
      const range = rangeFor(request.headers.get("range"), size);
      if (!range)
        return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
      const { start, end, partial } = range;
      const headers = {
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Cache-Control": "no-store",
      };
      if (partial) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
      return new Response(
        request.method === "HEAD"
          ? null
          : Readable.toWeb(fs.createReadStream(file, { start, end })),
        { status: partial ? 206 : 200, headers }
      );
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}
module.exports = { rangeFor, createAudioHandler };
