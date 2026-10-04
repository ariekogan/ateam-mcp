// What a stand-in Builder answers to a create-only upload (Builder #160): the
// request says if_absent, and a Builder that honoured it says which scope it
// created in `create_only`. A request WITHOUT if_absent gets no create_only,
// exactly as a Builder that does not know the field would answer, so a create
// that forgot to send it fails its test instead of passing against a stand-in
// that always says yes.
export function createOnlyAnswer(requestBody) {
  const ifAbsent = requestBody?.if_absent;
  if (ifAbsent === true) return { create_only: "connector" };
  if (ifAbsent && typeof ifAbsent === "object" && typeof ifAbsent.plugin === "string") return { create_only: "plugin" };
  return {};
}

/** JSON.parse that never throws: a stand-in reads whatever it was sent. */
export function parsedBody(text) {
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}
