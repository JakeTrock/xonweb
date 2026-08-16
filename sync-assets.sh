#!/bin/bash
# sync-assets.sh — Copy all needed Xonotic assets to the web assets directory
# Run this after updating gamecode or when adding new maps/assets

set -e

XON_DIR="/data/jake/reversing/xonweb/xonotic/data"
DATA_DIR="$XON_DIR/xonotic-data.pk3dir"
MAPS_DIR="$XON_DIR/xonotic-maps.pk3dir"
ASSETS_DIR="/data/jake/reversing/xonweb/assets/game"
DATA_DEST="$ASSETS_DIR/xonotic-data.pk3dir"
MAPS_DEST="$ASSETS_DIR/xonotic-maps.pk3dir"

echo "=== Syncing Xonotic assets to $ASSETS_DIR ==="

# --- From xonotic-data.pk3dir ---
echo "[1/8] Copying textures/ (1.7GB)..."
rsync -a --exclude='.git' "$DATA_DIR/textures/" "$DATA_DEST/textures/"

echo "[2/8] Copying models/ (436MB)..."
rsync -a --exclude='.git' "$DATA_DIR/models/" "$DATA_DEST/models/"

echo "[3/8] Copying sound/ (63MB)..."
rsync -a --exclude='.git' "$DATA_DIR/sound/" "$DATA_DEST/sound/"

echo "[4/8] Copying scripts/ (shaders)..."
rsync -a "$DATA_DIR/scripts/" "$DATA_DEST/scripts/"

echo "[5/8] Copying particles/, cubemaps/, effectinfo.txt, *.lno..."
rsync -a "$DATA_DIR/particles/" "$DATA_DEST/particles/"
rsync -a "$DATA_DIR/cubemaps/" "$DATA_DEST/cubemaps/"
cp -f "$DATA_DIR/effectinfo.txt" "$DATA_DEST/" 2>/dev/null || true
cp -f "$DATA_DIR/"*.lno "$DATA_DEST/" 2>/dev/null || true
cp -f "$DATA_DIR/"*.gmap.info "$DATA_DEST/" 2>/dev/null || true

# --- From xonotic-maps.pk3dir (xoylent-specific) ---
echo "[6/8] Copying xoylent map textures, models, sounds, env..."
mkdir -p "$MAPS_DEST/textures/map_xoylent" "$MAPS_DEST/textures/exx"
rsync -a "$MAPS_DIR/textures/map_xoylent/" "$MAPS_DEST/textures/map_xoylent/"
rsync -a "$MAPS_DIR/textures/exx/" "$MAPS_DEST/textures/exx/"

mkdir -p "$MAPS_DEST/env/extragalactic"
rsync -a "$MAPS_DIR/env/extragalactic/" "$MAPS_DEST/env/extragalactic/"

mkdir -p "$MAPS_DEST/models/map_xoylent"
rsync -a "$MAPS_DIR/models/map_xoylent/" "$MAPS_DEST/models/map_xoylent/"

mkdir -p "$MAPS_DEST/sound/map_xoylent"
rsync -a "$MAPS_DIR/sound/map_xoylent/" "$MAPS_DEST/sound/map_xoylent/"

echo "[7/8] Copying xoylent shader scripts..."
mkdir -p "$MAPS_DEST/scripts"
cp -f "$MAPS_DIR/scripts/map_xoylent.shader" "$MAPS_DEST/scripts/"
cp -f "$MAPS_DIR/scripts/exx.shader" "$MAPS_DEST/scripts/"
cp -f "$MAPS_DIR/scripts/skies_extragalactic.shader" "$MAPS_DEST/scripts/"
cp -f "$MAPS_DIR/scripts/shaderlist.txt" "$MAPS_DEST/scripts/" 2>/dev/null || true

# Also copy common shared shaders from maps dir that exx.shader might reference
for shader in common.shader decals.shader effects_beam.shader effects_forcefield.shader effects_item.shader effects_jumppad.shader effects_lightning.shader effects_warpzone.shader glassx.shader liquids_lava.shader liquids_slime.shader liquids_water.shader logos.shader; do
    cp -f "$MAPS_DIR/scripts/$shader" "$MAPS_DEST/scripts/" 2>/dev/null || true
done

echo "[8/8] Copying xoylent map preview..."
cp -f "$MAPS_DIR/maps/xoylent.jpg" "$MAPS_DEST/maps/" 2>/dev/null || true
mkdir -p "$MAPS_DEST/maps"
cp -f "$MAPS_DIR/maps/xoylent.mapinfo" "$MAPS_DEST/maps/" 2>/dev/null || true

# --- Summary ---
echo ""
echo "=== Asset sync complete ==="
echo "xonotic-data.pk3dir:"
du -sh "$DATA_DEST" 2>/dev/null
find "$DATA_DEST" -type f | wc -l | xargs -I{} echo "  {} files"
echo "xonotic-maps.pk3dir:"
du -sh "$MAPS_DEST" 2>/dev/null
find "$MAPS_DEST" -type f | wc -l | xargs -I{} echo "  {} files"
echo "Total assets:"
du -sh "$ASSETS_DIR" 2>/dev/null
