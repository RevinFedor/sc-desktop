#!/bin/bash

# Script to generate dev icon from base icon
# Requires ImageMagick: brew install imagemagick

if [ ! -f "icon.png" ]; then
  echo "Error: icon.png not found!"
  echo "Please create icon.png first (1024x1024)"
  exit 1
fi

echo "Generating icon-dev.png with blue overlay and DEV badge..."

magick icon.png \
  \( +clone -fill "rgba(50,150,255,0.4)" -colorize 100 \) \
  -composite \
  \( -size 380x140 xc:'#0066CC' \
     -draw "roundrectangle 0,0 380,140 20,20" \
     -font Arial-Bold -pointsize 100 -fill white \
     -gravity center -annotate +0+0 "DEV" \
  \) \
  -gravity southeast -geometry +40+40 \
  -composite \
  icon-dev.png

if [ $? -eq 0 ]; then
  echo "✅ icon-dev.png created successfully!"
  echo ""
  echo "Next steps:"
  echo "1. Generate .icns: electron-icon-builder --input=./icon.png --output=./"
  echo "2. Generate dev .icns: electron-icon-builder --input=./icon-dev.png --output=./"
  echo "3. Test: npm run dev"
else
  echo "❌ Failed to generate icon-dev.png"
  echo "Make sure ImageMagick is installed: brew install imagemagick"
fi
