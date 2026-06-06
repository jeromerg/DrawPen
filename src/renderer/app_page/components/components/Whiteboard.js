import React, { useCallback, useEffect, useRef, useState } from 'react';
import './Whiteboard.scss';

import { LuPanelRightClose, LuPanelRightOpen } from 'react-icons/lu';
import WhiteboardResizeFrame from './WhiteboardResizeFrame.js';
import WhiteboardSidebar from './WhiteboardSidebar.js';
import { minWhiteboardWidth, minWhiteboardHeight } from '../constants.js';

const getViewportSize = () => ({
  width: Math.max(1, window.innerWidth),
  height: Math.max(1, window.innerHeight),
});

const clampLayout = (layout, viewportSize) => {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const round = (value) => Number(value.toFixed(2));

  const widthPx = (layout.width / 100) * viewportSize.width;
  const heightPx = (layout.height / 100) * viewportSize.height;

  const clampedWidthPx = clamp(widthPx, minWhiteboardWidth, viewportSize.width);
  const clampedHeightPx = clamp(heightPx, minWhiteboardHeight, viewportSize.height);

  const width = (clampedWidthPx / viewportSize.width) * 100;
  const height = (clampedHeightPx / viewportSize.height) * 100;

  return {
    x: round(clamp(layout.x, 0, 100 - width)),
    y: round(clamp(layout.y, 0, 100 - height)),
    width: round(width),
    height: round(height),
  };
};

const resizeLayout = (layout, handle, deltaX, deltaY) => {
  const nextLayout = { ...layout };

  if (handle.includes('w')) {
    nextLayout.x += deltaX;
    nextLayout.width -= deltaX;
  }

  if (handle.includes('e')) {
    nextLayout.width += deltaX;
  }

  if (handle.includes('n')) {
    nextLayout.y += deltaY;
    nextLayout.height -= deltaY;
  }

  if (handle.includes('s')) {
    nextLayout.height += deltaY;
  }

  return nextLayout;
};

const moveLayout = (layout, deltaX, deltaY) => ({
  ...layout,
  x: layout.x + deltaX,
  y: layout.y + deltaY,
});

const SNAP_RESIZE_RATIOS = [30, 50, 70];
const CENTER_SNAP_HANDLE = 'center';
const CENTER_SNAP_LAYOUTS = [
  {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  },
  {
    x: 5,
    y: 5,
    width: 90,
    height: 90,
  },
  {
    x: 10,
    y: 10,
    width: 80,
    height: 80,
  },
];

const getSnapResizeLayout = (handle, ratio) => {
  const isLeft = handle.includes('w');
  const isRight = handle.includes('e');
  const isTop = handle.includes('n');
  const isBottom = handle.includes('s');

  return {
    x: isRight ? 100 - ratio : 0,
    y: isBottom ? 100 - ratio : 0,
    width: isLeft || isRight ? ratio : 100,
    height: isTop || isBottom ? ratio : 100,
  };
};

const getNextSnapIndex = (previousSnap, handle, snapCount) => (
  previousSnap.handle === handle ? (previousSnap.snapIndex + 1) % snapCount : 0
);

const Whiteboard = ({
  theme,
  layout,
  opacity,
  patternStyle,
  spacing,
  onChangeTheme,
  onChangeOpacity,
  onChangePatternStyle,
  onChangeSpacing,
  onChangeLayout,
}) => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isResizeMode, setIsResizeMode] = useState(false);
  const [viewportSize] = useState(getViewportSize);

  const currentLayout = clampLayout(layout, viewportSize);

  const interactionRef = useRef(null);
  const latestLayoutRef = useRef(null);
  const lastSnapResizeRef = useRef({ handle: null, snapIndex: -1 });

  latestLayoutRef.current = currentLayout;

  const updateLayout = useCallback((nextLayout, saveToStore) => {
    const clampedLayout = clampLayout(nextLayout, viewportSize);

    latestLayoutRef.current = clampedLayout;
    onChangeLayout(clampedLayout, saveToStore);
  }, [onChangeLayout, viewportSize]);

  const handlePointerMove = useCallback((event) => {
    const interaction = interactionRef.current;
    if (!interaction) return;

    const deltaX = ((event.clientX - interaction.startClientX) / viewportSize.width) * 100;
    const deltaY = ((event.clientY - interaction.startClientY) / viewportSize.height) * 100;

    const nextLayout = interaction.type === 'move'
      ? moveLayout(interaction.startLayout, deltaX, deltaY)
      : resizeLayout(interaction.startLayout, interaction.handle, deltaX, deltaY);

    updateLayout(nextLayout, false);
  }, [updateLayout, viewportSize]);

  const handlePointerUp = useCallback(() => {
    if (!interactionRef.current) return;

    interactionRef.current = null;

    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove]);

  const startInteraction = useCallback((event, type, handle = null) => {
    if (!isResizeMode) return;

    event.preventDefault();
    event.stopPropagation();

    interactionRef.current = {
      type: type,
      handle: handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLayout: currentLayout,
    };
    lastSnapResizeRef.current = { handle: null, snapIndex: -1 };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [currentLayout, handlePointerMove, handlePointerUp, isResizeMode]);

  const handleApplyResizeMode = useCallback((event) => {
    event?.preventDefault();
    event?.stopPropagation();

    interactionRef.current = null;
    updateLayout(latestLayoutRef.current, true);
    setIsResizeMode(false);

    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove, handlePointerUp, updateLayout]);

  const handleSnapResize = useCallback((event, handle) => {
    event.preventDefault();
    event.stopPropagation();

    const previousSnap = lastSnapResizeRef.current;
    const snapCount = handle === CENTER_SNAP_HANDLE ? CENTER_SNAP_LAYOUTS.length : SNAP_RESIZE_RATIOS.length;
    const nextSnapIndex = getNextSnapIndex(previousSnap, handle, snapCount);
    const nextLayout = handle === CENTER_SNAP_HANDLE ? CENTER_SNAP_LAYOUTS[nextSnapIndex] : getSnapResizeLayout(handle, SNAP_RESIZE_RATIOS[nextSnapIndex]);

    lastSnapResizeRef.current = { handle, snapIndex: nextSnapIndex };
    interactionRef.current = null;
    updateLayout(nextLayout, false);

    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove, handlePointerUp, updateLayout]);

  useEffect(() => {
    if (!isResizeMode && !isSidebarOpen) return;

    const handleKeyDown = (event) => {
      if (isResizeMode && ['Enter', 'Escape'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();

        handleApplyResizeMode();
        return;
      }

      if (isSidebarOpen && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();

        setIsSidebarOpen(false);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleApplyResizeMode, isResizeMode, isSidebarOpen]);

  const handleClickResize = () => {
    setIsSidebarOpen(false);
    setIsResizeMode(true);
    lastSnapResizeRef.current = { handle: null, snapIndex: -1 };
  };

  const SidebarIcon = isSidebarOpen ? LuPanelRightClose : LuPanelRightOpen;

  return (
    <div
      id="whiteboard"
      className={`${isSidebarOpen ? 'whiteboard--with-sidebar ' : ''}`}
      style={{
        '--whiteboard-x': `${currentLayout.x}%`,
        '--whiteboard-y': `${currentLayout.y}%`,
        '--whiteboard-width': `${currentLayout.width}%`,
        '--whiteboard-height': `${currentLayout.height}%`,
      }}
    >
      <div
        className={`whiteboard-background whiteboard-theme--${theme} whiteboard--style-${patternStyle}`}
        style={{
          '--whiteboard-opacity': `${opacity}%`,
          '--pattern-size': `${spacing}px`,
        }}
      />

      {
        !isResizeMode &&
          <WhiteboardSidebar
            theme={theme}
            opacity={opacity}
            patternStyle={patternStyle}
            spacing={spacing}
            onChangeTheme={onChangeTheme}
            onChangeOpacity={onChangeOpacity}
            onChangePatternStyle={onChangePatternStyle}
            onChangeSpacing={onChangeSpacing}
            onClickResize={handleClickResize}
          />
      }

      {
        !isResizeMode &&
          <div
            className={`whiteboard-toggle whiteboard-toggle--${theme}`}
            onClick={() => setIsSidebarOpen((prev) => !prev)}
          >
            <SidebarIcon className="whiteboard-toggle__icon" />
          </div>
      }

      {
        isResizeMode &&
          <WhiteboardResizeFrame
            onStartMove={(event) => startInteraction(event, 'move')}
            onStartResize={(event, handle) => startInteraction(event, 'resize', handle)}
            onSnapResize={handleSnapResize}
            onApply={handleApplyResizeMode}
          />
      }
    </div>
  );
};

export default Whiteboard;
