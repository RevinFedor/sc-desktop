# Icon Setup for GT Editor

## Required Icons

You need to create the following icon files:

### Production Icons
- `icon.png` - Base icon (1024x1024)
- `icon.icns` - macOS app icon (production)
- `icon.ico` - Windows app icon (production)

### Development Icons
- `icon-dev.png` - Dev icon with overlay (1024x1024)
- `icon-dev.icns` - macOS app icon (development)
- `icon-dev.ico` - Windows app icon (development)

## Icon Design Guidelines

### Production Icon
- Markdown editor/document theme
- **Unique color scheme**: Use cool colors (blue/green tones)
- Should represent "GT Editor" visually
- Different from Noted Terminal

### Development Icon
- Same base design as production
- **Add blue/green overlay** (semi-transparent)
- **Add "DEV" text badge** in corner
- Should be clearly distinguishable from Noted Terminal Dev

## How to Generate Icons

### Option 1: Using online tools
1. Create base PNG (1024x1024) in Figma/Sketch/Photoshop
2. Use https://cloudconvert.com/png-to-icns for .icns
3. Use https://cloudconvert.com/png-to-ico for .ico

### Option 2: Using electron-icon-builder (recommended)
```bash
npm install -g electron-icon-builder
electron-icon-builder --input=./icon.png --output=./
electron-icon-builder --input=./icon-dev.png --output=./
```

### Option 3: Using ImageMagick
```bash
brew install imagemagick
# For macOS .icns
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
```

## Creating DEV Overlay with ImageMagick

```bash
# Add red overlay and DEV text to icon-dev.png
convert icon.png \
  \( +clone -fill "rgba(255,0,0,0.3)" -colorize 100 \) \
  -composite \
  -gravity southeast \
  -font Arial-Bold -pointsize 120 -fill white \
  -stroke black -strokewidth 3 \
  -annotate +20+20 "DEV" \
  icon-dev.png
```

## Current Behavior

### Development Mode (`npm run dev`)
- Vite dev server runs on http://localhost:5173
- Electron loads from Vite (with HMR)
- Loads `icon-dev.png` for the window icon (if exists)
- Uses NODE_ENV=development
- DevTools open automatically

### Production Mode (`npm start` or built app)
- Vite builds to `dist/`
- Electron loads from `dist/`
- Uses `icon.icns` (macOS) or `icon.ico` (Windows)

## Testing

After creating icons:
```bash
# Test dev mode with icon
npm run dev

# Build production app with icon
npm run dist
```

The dev version should show a different icon in the dock/taskbar!
