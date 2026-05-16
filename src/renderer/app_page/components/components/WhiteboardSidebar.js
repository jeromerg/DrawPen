import React from 'react';

const OPACITY_MIN = 0;
const OPACITY_MAX = 100;
const OPACITY_STEP = 5;
const SPACING_MIN = 20;
const SPACING_MAX = 120;
const SPACING_STEP = 5;

const createSliderMarks = (min, max, step) => (
  Array.from({ length: (max - min) / step - 1 }, (_, index) => min + (index + 1) * step)
);
const getSliderProgress = (value, min, max) => {
  const numericValue = Number(value);
  const clampedValue = Math.min(max, Math.max(min, Number.isFinite(numericValue) ? numericValue : min));

  return ((clampedValue - min) / (max - min)) * 100;
};
const OPACITY_MARKS = createSliderMarks(OPACITY_MIN, OPACITY_MAX, OPACITY_STEP);
const SPACING_MARKS = createSliderMarks(SPACING_MIN, SPACING_MAX, SPACING_STEP);

const WHITEBOARD_THEMES = [
  { name: 'white', title: 'White' },
  { name: 'cream', title: 'Cream' },
  { name: 'blue',  title: 'Blue' },
  { name: 'slate', title: 'Slate' },
  { name: 'black', title: 'Black' },
];
const WHITEBOARD_STYLES = [
  { name: 'plain', title: 'Plain' },
  { name: 'dots',  title: 'Dots' },
  { name: 'lines', title: 'Lines' },
  { name: 'grid',  title: 'Grid' },
  { name: 'polka', title: 'Polka' },
];

const WhiteboardSidebar = ({
  theme,
  opacity,
  spacing,
  patternStyle,
  onChangeTheme,
  onChangeOpacity,
  onChangeSpacing,
  onChangePatternStyle,
  onClickResize,
}) => {
  const opacityProgress = getSliderProgress(opacity, OPACITY_MIN, OPACITY_MAX);
  const spacingProgress = getSliderProgress(spacing, SPACING_MIN, SPACING_MAX);

  return (
    <div className="whiteboard-sidebar">
      <div className="whiteboard-sidebar-panel">
        <div className="whiteboard-sidebar__head">Whiteboard Settings</div>

        <div className="whiteboard-sidebar__body">
          <div className="whiteboard-sidebar__section">
            <div className="whiteboard-sidebar__section-header">
              <div className="whiteboard-sidebar__label">Theme</div>
            </div>
            <div className="whiteboard-sidebar__section-body">
              <div className="whiteboard-sidebar__theme-list">
                {WHITEBOARD_THEMES.map((whiteboardTheme) => (
                  <div
                    key={whiteboardTheme.name}
                    className={`whiteboard-sidebar__theme${theme === whiteboardTheme.name ? ' active' : ''}`}
                    onClick={() => onChangeTheme(whiteboardTheme.name)}
                  >
                    <div className={`whiteboard-sidebar__theme-preview whiteboard-sidebar__theme-preview--${whiteboardTheme.name}`} />

                    <div>{whiteboardTheme.title}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="whiteboard-sidebar__section">
            <div className="whiteboard-sidebar__section-header">
              <div className="whiteboard-sidebar__label">Opacity</div>
              <div className="whiteboard-sidebar__value">{opacity}%</div>
            </div>

            <div className="whiteboard-sidebar__section-body">
              <div
                className="whiteboard-slider"
                style={{ '--whiteboard-slider-progress': `${opacityProgress}%` }}
              >
                <input
                  className="whiteboard-slider__input"
                  type="range"
                  min={OPACITY_MIN}
                  max={OPACITY_MAX}
                  step={OPACITY_STEP}
                  value={opacity}
                  aria-label="Whiteboard opacity"
                  onChange={(event) => onChangeOpacity(Number(event.target.value))}
                />

                <div className="whiteboard-slider__rail" />
                <div className="whiteboard-slider__track" />

                {OPACITY_MARKS.map((mark) => (
                  <div
                    key={mark}
                    className={`whiteboard-slider__mark${mark <= opacityProgress ? ' active' : ''}`}
                    style={{ left: `${mark}%` }}
                  />
                ))}

                <div className="whiteboard-slider__thumb" />
              </div>
            </div>
          </div>

          <div className="whiteboard-sidebar__section">
            <div className="whiteboard-sidebar__section-header">
              <div className="whiteboard-sidebar__label">Spacing</div>
              <div className="whiteboard-sidebar__value">{spacing}px</div>
            </div>

            <div className="whiteboard-sidebar__section-body">
              <div
                className="whiteboard-slider"
                style={{ '--whiteboard-slider-progress': `${spacingProgress}%` }}
              >
                <input
                  className="whiteboard-slider__input"
                  type="range"
                  min={SPACING_MIN}
                  max={SPACING_MAX}
                  step={SPACING_STEP}
                  value={spacing}
                  aria-label="Whiteboard pattern spacing"
                  onChange={(event) => onChangeSpacing(Number(event.target.value))}
                />

                <div className="whiteboard-slider__rail" />
                <div className="whiteboard-slider__track" />

                {SPACING_MARKS.map((mark) => (
                  <div
                    key={mark}
                    className={`whiteboard-slider__mark${mark <= spacing ? ' active' : ''}`}
                    style={{ left: `${getSliderProgress(mark, SPACING_MIN, SPACING_MAX)}%` }}
                  />
                ))}

                <div className="whiteboard-slider__thumb" />
              </div>
            </div>
          </div>

          <div className="whiteboard-sidebar__section">
            <div className="whiteboard-sidebar__section-header">
              <div className="whiteboard-sidebar__label">Style</div>
            </div>
            <div className="whiteboard-sidebar__section-body">
              <div className="whiteboard-sidebar__style-list">
                {WHITEBOARD_STYLES.map((whiteboardStyle) => (
                  <div
                    key={whiteboardStyle.name}
                    className={`whiteboard-sidebar__style${patternStyle === whiteboardStyle.name ? ' active' : ''}`}
                    onClick={() => onChangePatternStyle(whiteboardStyle.name)}
                  >
                    <div className='whiteboard-sidebar__style-preview-wrapper'>
                      <div className={`whiteboard-sidebar__style-preview whiteboard-sidebar__style-preview--${whiteboardStyle.name}`} />
                    </div>

                    <div>{whiteboardStyle.title}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="whiteboard-sidebar__section">
            <div className="whiteboard-sidebar__section-header">
              <div className="whiteboard-sidebar__label whiteboard-sidebar__label-link" onClick={onClickResize}>Resize</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WhiteboardSidebar;
