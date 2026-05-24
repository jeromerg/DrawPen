import React from 'react';
import './WhiteboardResizeFrame.scss';

const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const WhiteboardResizeFrame = ({
  onStartMove,
  onStartResize,
  onSnapResize,
  onApply,
}) => (
  <div
    className="whiteboard-resize-frame"
    onPointerDown={onStartMove}
    onDoubleClick={onApply}
  >
    <div className="whiteboard-resize-frame__hint">
      <span>Double</span>
      <span>click</span>
    </div>

    <svg className="whiteboard-resize-frame__border">
      <rect x="0" y="0" width="100%" height="100%" rx="20" ry="20" />
    </svg>

    {
      RESIZE_HANDLES.map((handle) => (
        <div
          key={handle}
          className={`whiteboard-resize-frame__handle whiteboard-resize-frame__handle--${handle}`}
          onPointerDown={(event) => onStartResize(event, handle)}
        />
      ))
    }

    {
      RESIZE_HANDLES.map((handle) => (
        <div
          key={handle}
          className={`whiteboard-resize-frame__snap whiteboard-resize-frame__snap--${handle}`}
          onPointerDown={(event) => onSnapResize(event, handle)}
        >
          <div className="whiteboard-resize-frame__snap-preview">
            <div className="whiteboard-resize-frame__snap-preview-fill" />
          </div>
        </div>
      ))
    }
  </div>
);

export default WhiteboardResizeFrame;
