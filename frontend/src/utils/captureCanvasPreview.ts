/**
 * Capture Canvas Preview
 *
 * Captures the real simulator canvas as a preview image for examples
 */

import type { ExampleProject } from '../data/examples';

/**
 * Wait for all wokwi-elements components to be defined
 */
async function waitForComponents(): Promise<void> {
  const componentTags = ['wokwi-arduino-uno', 'wokwi-led', 'wokwi-rgb-led', 'wokwi-pushbutton'];

  const promises = componentTags.map((tag) => {
    if (customElements.get(tag)) {
      return Promise.resolve();
    }
    return customElements.whenDefined(tag);
  });

  await Promise.all(promises);
}

/**
 * Create a temporary canvas with the example circuit
 */
async function createPreviewCanvas(example: ExampleProject): Promise<HTMLCanvasElement> {
  // Wait for components to be loaded
  await waitForComponents();

  // Create temporary container
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-10000px';
  container.style.width = '800px';
  container.style.height = '600px';
  container.style.backgroundColor = '#1e1e1e';
  document.body.appendChild(container);

  // Create SVG for rendering
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '800');
  svg.setAttribute('height', '600');
  svg.style.backgroundColor = '#1e1e1e';
  container.appendChild(svg);

  // Calculate bounds for all components
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;

  example.components.forEach((comp) => {
    minX = Math.min(minX, comp.x);
    maxX = Math.max(maxX, comp.x + 150);
    minY = Math.min(minY, comp.y);
    maxY = Math.max(maxY, comp.y + 150);
  });

  // Add padding
  const padding = 40;
  minX -= padding;
  minY -= padding;
  maxX += padding;
  maxY += padding;

  // Calculate scale to fit
  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;
  const scaleX = 760 / contentWidth;
  const scaleY = 560 / contentHeight;
  const scale = Math.min(scaleX, scaleY, 1);

  // Center offset
  const offsetX = (800 - contentWidth * scale) / 2 - minX * scale;
  const offsetY = (600 - contentHeight * scale) / 2 - minY * scale;

  // Create group for all components
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.setAttribute('transform', `translate(${offsetX}, ${offsetY}) scale(${scale})`);
  svg.appendChild(group);

  // Render each component as foreignObject
  for (const comp of example.components) {
    const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    foreignObject.setAttribute('x', comp.x.toString());
    foreignObject.setAttribute('y', comp.y.toString());
    foreignObject.setAttribute('width', '150');
    foreignObject.setAttribute('height', '150');

    // Create the actual wokwi element
    const element = document.createElement(comp.type);

    // Set properties
    Object.entries(comp.properties).forEach(([key, value]) => {
      if (key !== 'state') {
        element.setAttribute(key, String(value));
      }
    });

    foreignObject.appendChild(element);
    group.appendChild(foreignObject);
  }

  // Draw wires
  example.wires.forEach((wire) => {
    const startComp = example.components.find((c) => c.id === wire.start.componentId);
    const endComp = example.components.find((c) => c.id === wire.end.componentId);

    if (startComp && endComp) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', (startComp.x + 75).toString());
      line.setAttribute('y1', (startComp.y + 75).toString());
      line.setAttribute('x2', (endComp.x + 75).toString());
      line.setAttribute('y2', (endComp.y + 75).toString());
      line.setAttribute('stroke', wire.color);
      line.setAttribute('stroke-width', '3');
      group.appendChild(line);
    }
  });

  // Wait for rendering
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Convert SVG to canvas
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvas.getContext('2d')!;

  // Draw background
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, 800, 600);

  // Convert SVG to image
  const svgData = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });

  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);

  // Cleanup
  document.body.removeChild(container);

  return canvas;
}

/**
 * Generate a preview image data URL for an example
 */
export async function generateCanvasPreview(example: ExampleProject): Promise<string> {
  try {
    const canvas = await createPreviewCanvas(example);
    return canvas.toDataURL('image/png');
  } catch (error) {
    console.error('Failed to generate preview for', example.id, error);
    return '';
  }
}

/**
 * Generate previews for all examples and return a map
 */
export async function generateAllPreviews(
  examples: ExampleProject[],
): Promise<Map<string, string>> {
  const previews = new Map<string, string>();

  for (const example of examples) {
    const preview = await generateCanvasPreview(example);
    if (preview) {
      previews.set(example.id, preview);
    }
  }

  return previews;
}
