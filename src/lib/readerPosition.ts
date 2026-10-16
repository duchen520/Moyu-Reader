// Paragraphs are in normal document order. Locate the first visible paragraph
// without measuring every paragraph above it on each scroll event.
export function readingParagraph(nodes: (HTMLParagraphElement | null)[], viewportTop: number): number {
  let low = 0, high = nodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const node = nodes[middle];
    if (!node || node.getBoundingClientRect().bottom >= viewportTop + 30) high = middle;
    else low = middle + 1;
  }
  return Math.max(0, Math.min(low, nodes.length - 1));
}
