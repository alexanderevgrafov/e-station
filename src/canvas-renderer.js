import _ from 'lodash'
import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';

export class CanvasRenderer {
  constructor(canvasWidth = 400, canvasHeight = 300) {
    this.canvas = createCanvas(canvasWidth, canvasHeight);
    this.ctx = this.canvas.getContext('2d');
    this.spec = null; // Store the full specification for path/id lookups
    this.areaIdMap = new Map(); // Map of id -> area path for quick ID lookups

    this.bgColor = '#ffffff';
  }

  saveToFile(path = 'output.png') {
    const buffer = this.canvas.toBuffer('image/png');
    fs.writeFileSync(path, buffer);
  }

  // Main rendering function
  async render(spec) {
    this.spec = spec; // Store spec for path/id operations
    this.buildIdMap(spec); // Build ID mapping

    if (typeof spec === 'object' && spec.areas) {
      // Single area with sub-areas
      await this.renderArea(spec);
    } else if (typeof spec === 'object' && !spec.areas) {
      // Single area without sub-areas
      await this.renderArea(spec);
    } else {
      console.warn('Invalid spec format');
    }
  }

  // Build mapping of IDs to paths
  buildIdMap(spec, currentPath = '') {
    if (spec.id) {
      this.areaIdMap.set(spec.id, currentPath);
    }

    if (spec.areas && typeof spec.areas === 'object') {
      Object.keys(spec.areas).forEach(key => {
        const childPath = currentPath ? `${currentPath}.areas.${key}` : `areas.${key}`;
        this.buildIdMap(spec.areas[key], childPath);
      });
    }
  }

  // Get area by dot-separated path
  getAreaByPath(path) {
    if (!this.spec) return null;

    const parts = path.split('.');
    let current = this.spec;

    for (const part of parts) {
      if (current && current[part] !== undefined) {
        current = current[part];
      } else {
        return null;
      }
    }

    return current;
  }

  // Get area by ID
  getAreaById(id) {
    const path = this.areaIdMap.get(id);
    if (!path) return null;

    if (path === '') {
      // Root area has the ID
      return this.spec;
    }

    return this.getAreaByPath(path);
  }

  // Render specific area by path
  async renderAreaByPath(path, parentWidth = this.canvas.width, parentHeight = this.canvas.height) {
    const area = this.getAreaByPath(path);
    if (!area) {
      console.warn(`Area not found at path: ${path}`);
      return;
    }

    await this.renderArea(area, parentWidth, parentHeight);
  }

  // Render specific area by ID
  async renderAreaById(id, parentWidth = this.canvas.width, parentHeight = this.canvas.height) {
    const area = this.getAreaById(id);
    if (!area) {
      console.warn(`Area not found with ID: ${id}`);
      return;
    }

    await this.renderArea(area, parentWidth, parentHeight);
  }

  // Convert percentage strings to absolute values
  parseCoordinate(value, referenceSize, defaultValue = 0) {
    if (typeof value === 'string' && value.endsWith('%')) {
      const percentage = parseFloat(value.slice(0, -1));
      return (percentage / 100) * referenceSize;
    }
    return typeof value === 'number' ? value : defaultValue;
  }

  // Render individual area
  async renderArea(area, parentWidth = this.canvas.width, parentHeight = this.canvas.height) {
    // Parse coordinates with percentage support
    const x = this.parseCoordinate(area.x, parentWidth, 0);
    const y = this.parseCoordinate(area.y, parentHeight, 0);
    const width = this.parseCoordinate(area.width, parentWidth, this.canvas.width);
    const height = this.parseCoordinate(area.height, parentHeight, this.canvas.height);

    const {
      type = 'text',
      align = 'left',
      vAlign = 'top'
    } = area;

    // Save canvas state
    this.ctx.save();

    // Set clipping region for the area
    this.ctx.beginPath();
    this.ctx.fillStyle = this.bgColor;
    this.ctx.fillRect(x, y, width, height);
    this.ctx.rect(x, y, width, height);
    this.ctx.clip();

    try {
      switch (type.toLowerCase()) {
        case 'text':
          await this.renderText({ ...area, x, y, width, height });
          break;
        case 'image':
          await this.renderImage({ ...area, x, y, width, height });
          break;
        case 'group':
          await this.renderGroup({ ...area, x, y, width, height });
          break;
        case 'function':
          await this.renderFunction({ ...area, x, y, width, height });
          break;
        default:
          console.warn(`Unknown area type: ${type}`);
      }
    } catch (error) {
      console.error(`Error rendering area:`, error);
    }

    // Restore canvas state
    this.ctx.restore();
  }

  // Render text content
  async renderText(area) {
    const {
      x,
      y,
      width,
      height,
      text = '',
      font = '16px Arial',
      fontSize,
      fontFamily = 'Arial',
      color = '#000000',
      align = 'left',
      vAlign = 'top'
    } = area;

    // Set font - prioritize fontSize and fontFamily if provided
    if (fontSize && fontFamily) {
      this.ctx.font = `${fontSize}px ${fontFamily}`;
    } else {
      this.ctx.font = font;
    }

    this.ctx.fillStyle = color;
    this.ctx.textBaseline = 'top';

    // Measure text dimensions
    const metrics = this.ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = parseInt(this.ctx.font); // Approximate height from font size

    // Calculate position based on alignment
    let textX = x;
    let textY = y;

    // Horizontal alignment
    switch (align.toLowerCase()) {
      case 'center':
        textX = x + (width - textWidth) / 2;
        break;
      case 'right':
        textX = x + width - textWidth;
        break;
      case 'left':
      default:
        textX = x;
        break;
    }

    // Vertical alignment
    switch (vAlign.toLowerCase()) {
      case 'center':
      case 'middle':
        textY = y + (height - textHeight) / 2;
        break;
      case 'bottom':
        textY = y + height - textHeight;
        break;
      case 'top':
      default:
        textY = y;
        break;
    }

    this.ctx.fillText(text, textX, textY);
  }

  // Render image content
  async renderImage(area) {
    const {
      x,
      y,
      width,
      height,
      imagePath,
      imageCanvas,
      align = 'left',
      vAlign = 'top',
      fit = 'contain' // contain, cover, fill, none
    } = area;

    let image;

    try {
      if (imageCanvas) {
        // Use another canvas as image source
        image = imageCanvas;
      } else if (imagePath) {
        // Load image from path
        image = await loadImage(imagePath);
      } else {
        console.warn('No image source provided (imagePath or imageCanvas)');
        return;
      }

      // Calculate image dimensions and position
      let srcWidth = image.width;
      let srcHeight = image.height;
      let destWidth = width;
      let destHeight = height;
      let destX = x;
      let destY = y;

      if (fit !== 'fill') {
        // Calculate aspect ratios
        const imageAspect = srcWidth / srcHeight;
        const areaAspect = width / height;

        if (fit === 'contain') {
          if (imageAspect > areaAspect) {
            // Image is wider - fit to width
            destWidth = width;
            destHeight = width / imageAspect;
          } else {
            // Image is taller - fit to height
            destWidth = height * imageAspect;
            destHeight = height;
          }
        } else if (fit === 'cover') {
          if (imageAspect > areaAspect) {
            // Image is wider - fit to height
            destWidth = height * imageAspect;
            destHeight = height;
          } else {
            // Image is taller - fit to width
            destWidth = width;
            destHeight = width / imageAspect;
          }
        } else if (fit === 'none') {
          destWidth = srcWidth;
          destHeight = srcHeight;
        }

        // Apply alignment
        switch (align.toLowerCase()) {
          case 'center':
            destX = x + (width - destWidth) / 2;
            break;
          case 'right':
            destX = x + width - destWidth;
            break;
          case 'left':
          default:
            destX = x;
            break;
        }

        switch (vAlign.toLowerCase()) {
          case 'center':
          case 'middle':
            destY = y + (height - destHeight) / 2;
            break;
          case 'bottom':
            destY = y + height - destHeight;
            break;
          case 'top':
          default:
            destY = y;
            break;
        }
      }

      this.ctx.drawImage(image, destX, destY, destWidth, destHeight);

    } catch (error) {
      console.error('Error loading image:', error);
    }
  }

  // Render group content
  async renderGroup(area) {
    const {
      x,
      y,
      width,
      height,
      areas = {}
    } = area;

    // Render child areas relative to this group's position
    for (const [key, childArea] of Object.entries(areas)) {
      // Child coordinates are relative to this group, so pass group dimensions as reference
      await this.renderArea(childArea, width, height);
    }
  }

  // Render function content
  async renderFunction(area) {
    const { func } = area;

    if (typeof func === 'function') {
      try {
        // Call the function with area spec and canvas context
        await func(area, this.ctx);
      } catch (error) {
        console.error('Error executing custom function:', error);
      }
    } else {
      console.warn('Function type specified but no valid function provided');
    }
  }
}

// Example usage:
async function example() {
  const renderer = new CanvasRenderer(400, 300);

  const spec = {
    id: 'root',
    type: 'group',
    x: 0,
    y: 0,
    width: '100%',
    height: '100%',
    areas: {
      header: {
        id: 'main-header',
        type: 'text',
        x: '6.25%',    // 50px of 800px
        y: '8.33%',    // 50px of 600px
        width: '87.5%', // 700px of 800px
        height: '16.67%', // 100px of 600px
        text: 'Hello, Canvas!',
        fontSize: 48,
        fontFamily: 'Arial',
        color: '#333333',
        align: 'center',
        vAlign: 'center'
      },
      subtitle: {
        id: 'sub-text',
        type: 'text',
        x: '12.5%',     // 100px of 800px
        y: '33.33%',    // 200px of 600px
        width: '75%',   // 600px of 800px
        height: '8.33%', // 50px of 600px
        text: 'This text uses named areas',
        fontSize: 24,
        align: 'center',
        vAlign: 'center'
      },
      content: {
        id: 'main-content',
        type: 'group',
        x: '6.25%',
        y: '50%',
        width: '87.5%',
        height: '33.33%',
        areas: {
          background: {
            type: 'function',
            x: 0,
            y: 0,
            width: '100%',
            height: '100%',
            func: (area, ctx) => {
              ctx.fillStyle = '#ff6b6b';
              ctx.fillRect(area.x + 10, area.y + 10, area.width - 20, area.height - 20);
            }
          },
          circle: {
            id: 'center-circle',
            type: 'function',
            x: '25%',
            y: '25%',
            width: '50%',
            height: '50%',
            func: (area, ctx) => {
              ctx.fillStyle = '#4ecdc4';
              ctx.beginPath();
              ctx.arc(area.x + area.width/2, area.y + area.height/2, 50, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }
    }
  };

  // Render entire canvas
  await renderer.render(spec);

  // Examples of selective rendering:

  // Render only the header by path


  // Render only the subtitle by ID
  // await renderer.renderAreaById('sub-text');

  // Render nested area by path
  // await renderer.renderAreaByPath('areas.content.areas.circle');

  // Render nested area by ID
  // await renderer.renderAreaById('center-circle');

  renderer.saveToFile('out' + Date.now() + '-a.png');

  _.set(spec, "areas.header.text", "Welcome to EPD!");
  _.set(spec, "areas.header.align", "right");
  _.set(spec, "areas.header.vAlign", "bottom");

  await renderer.renderAreaByPath('areas.header');

  renderer.saveToFile('out' + Date.now() + '-b.png');

}

example().catch(console.error);