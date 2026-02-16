import { readJsonBody, sendJson } from "./http-utils.js";

export const createStateRouteHandler = ({ workspace, memoryPreviewChars }) => async (
  req,
  res,
  path
) => {
  if (req.method === "GET" && path === "/state") {
    const [skills, memory] = await Promise.all([workspace.listSkills(), workspace.readMemory()]);
    sendJson(res, 200, {
      ...workspace.summary(),
      skills,
      memoryPreview: memory.slice(-memoryPreviewChars)
    });
    return true;
  }

  if (req.method === "GET" && path === "/state/memory") {
    const memory = await workspace.readMemory();
    sendJson(res, 200, { memory });
    return true;
  }

  if (req.method === "POST" && path === "/state/memory") {
    const body = await readJsonBody(req);
    if (typeof body.text !== "string" || !body.text.trim()) {
      sendJson(res, 400, { error: "Body must include string field `text`." });
      return true;
    }
    await workspace.appendMemory(body.text);
    const memory = await workspace.readMemory();
    sendJson(res, 201, { memory });
    return true;
  }

  if (req.method === "GET" && path === "/state/system") {
    const systemPrompt = await workspace.readSystemPrompt();
    sendJson(res, 200, { systemPrompt });
    return true;
  }

  if (req.method === "POST" && path === "/state/system") {
    const body = await readJsonBody(req);
    if (typeof body.systemPrompt !== "string") {
      sendJson(res, 400, { error: "Body must include string field `systemPrompt`." });
      return true;
    }
    await workspace.writeSystemPrompt(body.systemPrompt);
    const systemPrompt = await workspace.readSystemPrompt();
    sendJson(res, 201, { systemPrompt });
    return true;
  }

  if (req.method === "GET" && path === "/state/skills") {
    const skills = await workspace.listSkills();
    sendJson(res, 200, { skills, skillsDir: workspace.summary().skillsDir });
    return true;
  }

  return false;
};
