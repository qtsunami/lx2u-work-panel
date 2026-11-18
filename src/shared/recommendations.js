// Local, explainable historical artifact suggestions. No model call and no
// external data access; matching is an aid to discovery, not verification.
function recommendationTerms(value) {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  const words = text.match(/[a-z0-9]{2,}|[\u3400-\u9fff]+/g) || [];
  const terms = new Set();
  for (const word of words) {
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      for (let i = 0; i + 1 < word.length; i++) terms.add(word.slice(i, i + 2));
    } else terms.add(word);
  }
  return terms;
}

/** Recommend artifacts belonging to other live tasks based on project/terms. */
export function recommendArtifacts(workspace, taskId, limit = 5) {
  if (!workspace || !Array.isArray(workspace.tasks) || !Array.isArray(workspace.artifacts)) return [];
  const tasks = new Map(workspace.tasks.filter(t => t && t.id && !t.deletedAt).map(t => [t.id, t]));
  const current = tasks.get(taskId);
  if (!current) return [];
  const currentTerms = recommendationTerms([current.title, current.description, current.expected].filter(Boolean).join(' '));
  const ranked = [];
  for (const artifact of workspace.artifacts) {
    if (!artifact || !artifact.id || !artifact.taskId || artifact.taskId === taskId || artifact.deletedAt) continue;
    const source = tasks.get(artifact.taskId);
    if (!source) continue;
    const terms = recommendationTerms([source.title, source.description, artifact.summary].filter(Boolean).join(' '));
    let shared = 0;
    for (const term of currentTerms) if (terms.has(term)) shared++;
    const sameProject = !!current.projectId && current.projectId === source.projectId;
    if (!sameProject && shared < 2) continue;
    ranked.push({ artifact, task: source, reason: sameProject && shared >= 2 ? '同一项目，内容有相似词' : sameProject ? '同一项目' : '内容有相似词',
      score: (sameProject ? 4 : 0) + Math.min(shared, 6) });
  }
  ranked.sort((a, b) => b.score - a.score || String(b.artifact.createdAt || b.artifact.at || '').localeCompare(String(a.artifact.createdAt || a.artifact.at || '')) || String(a.artifact.id).localeCompare(String(b.artifact.id)));
  return ranked.slice(0, Number.isInteger(limit) ? Math.max(0, Math.min(limit, 20)) : 5);
}
