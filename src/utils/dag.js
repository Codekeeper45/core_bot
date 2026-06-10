'use strict';
// Удаление циклов из графа зависимостей. Граф задаётся как Map<node, node[]>
// (node → список узлов, от которых он зависит). Возвращает очищенный граф (DAG)
// и список отброшенных рёбер [from, to], образующих циклы.
//
// Алгоритм: DFS с тремя цветами. Ребро в «серый» (на стеке) узел — back-edge,
// замыкающее цикл; такое ребро отбрасываем.
function pruneCycles(edges) {
  const adj = new Map();
  for (const [from, tos] of edges) {
    adj.set(from, Array.from(new Set((tos || []).map(String))));
  }
  // гарантируем, что все упомянутые узлы есть как ключи
  for (const tos of adj.values()) {
    for (const to of tos) if (!adj.has(to)) adj.set(to, []);
  }

  const WHITE = 0; const GRAY = 1; const BLACK = 2;
  const color = new Map([...adj.keys()].map((n) => [n, WHITE]));
  const dropped = [];
  const clean = new Map([...adj.keys()].map((n) => [n, []]));

  function dfs(u) {
    color.set(u, GRAY);
    for (const v of adj.get(u)) {
      if (color.get(v) === GRAY) {
        dropped.push([u, v]); // back-edge → цикл, отбрасываем
      } else {
        clean.get(u).push(v);
        if (color.get(v) === WHITE) dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const n of adj.keys()) if (color.get(n) === WHITE) dfs(n);

  return { adj: clean, dropped };
}

module.exports = { pruneCycles };
