import type { GlobalThemeOverrides } from 'naive-ui'

/**
 * Naive UI overrides, expressed in Keep design system values.
 *
 * These have to be literal strings rather than `var(--token)`: Naive
 * derives hover/pressed/disabled variants by computing on the color it is
 * given, and it cannot compute on a CSS variable. Every value below is
 * the resolved value of the Keep token named in the trailing comment —
 * if you change a token in keep-tokens.scss, change it here too.
 *
 * Button heights follow Keep §9.1: XL 50 / L 48 / M 36 / S 28 / XS 24.
 */

const FONT_CN =
  "'PingFang VF', 'PingFang SC', 'Noto Sans SC', -apple-system, 'Helvetica Neue', Arial, sans-serif"
const FONT_MONO = "'SF Mono', ui-monospace, Menlo, Consolas, 'PingFang SC', monospace"

export const lightThemeOverrides: GlobalThemeOverrides = {
  common: {
    // Primary actions are ink pills. Purple is a classification accent,
    // not the action color — see variables.scss.
    primaryColor: '#333333', // --gray-33
    primaryColorHover: '#000000', // --gray-00
    primaryColorPressed: '#000000',
    primaryColorSuppl: '#333333',

    successColor: '#24C789', // --keep-green
    errorColor: '#E63A30', // --danger
    warningColor: '#FEC833', // --warning
    infoColor: '#5A87F9', // --hue-blue

    bodyColor: '#FFFFFF', // --bg
    cardColor: '#FFFFFF',
    modalColor: '#FFFFFF',
    popoverColor: '#FFFFFF',
    tableColor: '#FFFFFF',
    inputColor: '#FFFFFF',
    actionColor: '#F7F7F7', // --bg-soft

    textColorBase: '#000000', // --fg-title
    textColor1: '#000000', // --fg-title
    textColor2: '#333333', // --fg-primary
    textColor3: '#999999', // --fg-aux

    dividerColor: '#F2F2F2', // --divider
    // Controls need a border you can actually see; --divider is a
    // separator value and disappears as an input outline.
    borderColor: '#E3E3E3', // --gray-e0
    hoverColor: 'rgba(0, 0, 0, 0.04)',

    // Naive's general radius covers inputs, cards, popovers and dropdowns —
    // §8.1's "large card" step. borderRadiusSmall covers tags and other small
    // controls, which is the "small card" step. Both moved when the ladder did
    // (8/6 were the desktop extension the spec doesn't have).
    borderRadius: '6px', // --r-card
    borderRadiusSmall: '2px', // --r-ctl

    fontSize: '14px', // --t-14
    fontSizeMedium: '14px',
    heightLarge: '48px', // --btn-l-h
    heightMedium: '36px', // --btn-m-h
    heightSmall: '28px', // --btn-s-h
    heightTiny: '24px', // --btn-xs-h

    fontFamily: FONT_CN,
    fontFamilyMono: FONT_MONO,
  },
  Layout: {
    color: '#FFFFFF', // --bg
    siderColor: '#FAFAFA', // --bg-softer
    headerColor: '#FFFFFF',
  },
  Menu: {
    itemTextColorActive: '#000000',
    itemTextColorActiveHover: '#000000',
    itemTextColorChildActive: '#000000',
    itemIconColorActive: '#000000',
    itemIconColorActiveHover: '#000000',
    itemColorActive: 'rgba(0, 0, 0, 0.06)',
    itemColorActiveHover: 'rgba(0, 0, 0, 0.1)',
    arrowColorActive: '#000000',
  },
  Button: {
    textColorPrimary: '#FFFFFF',
    colorPrimary: '#333333',
    colorHoverPrimary: '#000000',
    colorPressedPrimary: '#000000',
  },
  Input: {
    color: '#FFFFFF',
    colorFocus: '#FFFFFF',
    border: '1px solid #E3E3E3',
    borderHover: '1px solid #999999',
    borderFocus: '1px solid #333333',
    borderDisabled: '1px solid #F2F2F2',
    groupLabelBorder: '1px solid #E3E3E3',
    placeholderColor: '#CCCCCC', // --fg-disabled
    caretColor: '#000000',
  },
  InternalSelection: {
    border: '1px solid #E3E3E3',
    borderHover: '1px solid #999999',
    borderActive: '1px solid #333333',
    borderFocus: '1px solid #333333',
  },
  Card: {
    color: '#FFFFFF',
    borderColor: '#F2F2F2',
  },
  Modal: {
    color: '#FFFFFF',
  },
  Tag: {
    borderRadius: '2px', // --r-ctl — a tag is a small control, not a card
  },
  Switch: {
    railColor: '#CCCCCC', // prototype Toggle off = --gray-cc
    // On = --hue-purple, not --keep-green. Green is this system's *status*
    // color (running / succeeded); a switch is a selected state. See KpToggle.
    railColorActive: '#6D51F4', // --hue-purple
    loadingColor: '#333333',
    opacityDisabled: 0.4,
    // Prototype Toggle: 38x22 track, 18px knob, 2px inset
    railHeightSmall: '22px',
    railWidthSmall: '38px',
    buttonHeightSmall: '18px',
    buttonWidthSmall: '18px',
    railHeightMedium: '22px',
    railWidthMedium: '38px',
    buttonHeightMedium: '18px',
    buttonWidthMedium: '18px',
  },
}

export const darkThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#FFFFFF',
    primaryColorHover: '#CCCCCC', // --gray-cc
    primaryColorPressed: '#CCCCCC',
    primaryColorSuppl: '#FFFFFF',

    successColor: '#24C789',
    errorColor: '#E63A30',
    warningColor: '#FEC833',
    infoColor: '#5A87F9',

    // The prototype lifts the DS dark ramp one step: content ground is
    // #0D0D0D, not pure black. Cards / modals / popovers sit ON the ground
    // (bg + ring), inputs fill with surface-2.
    bodyColor: '#0D0D0D', // --bg (dark)
    cardColor: '#0D0D0D',
    modalColor: '#0D0D0D',
    popoverColor: '#0D0D0D',
    tableColor: '#0D0D0D',
    inputColor: '#1F1F1F', // --surface-2 (dark)
    actionColor: '#232323', // --bg-soft (dark)

    textColorBase: '#FFFFFF', // --fg-title
    textColor1: '#FFFFFF',
    textColor2: '#CCCCCC', // --fg-primary
    textColor3: '#666666', // --fg-aux

    dividerColor: '#262626', // --dark-divider
    borderColor: '#262626',
    hoverColor: 'rgba(255, 255, 255, 0.10)', // ≈ --surface-3 over the ground

    borderRadius: '6px', // --r-card
    borderRadiusSmall: '2px', // --r-ctl

    fontSize: '14px',
    fontSizeMedium: '14px',
    heightLarge: '48px',
    heightMedium: '36px',
    heightSmall: '28px',
    heightTiny: '24px',

    fontFamily: FONT_CN,
    fontFamilyMono: FONT_MONO,
  },
  Layout: {
    color: '#0D0D0D', // --bg (dark)
    siderColor: '#1A1A1A', // --bg-softer (dark) — sidebar one step brighter
    headerColor: '#0D0D0D',
  },
  Menu: {
    itemTextColorActive: '#FFFFFF',
    itemTextColorActiveHover: '#FFFFFF',
    itemTextColorChildActive: '#FFFFFF',
    itemIconColorActive: '#FFFFFF',
    itemIconColorActiveHover: '#FFFFFF',
    itemColorActive: 'rgba(255, 255, 255, 0.12)', // --selected-bg (dark)
    itemColorActiveHover: 'rgba(255, 255, 255, 0.16)',
    arrowColorActive: '#FFFFFF',
  },
  Button: {
    textColorPrimary: '#000000',
    colorPrimary: '#FFFFFF',
    colorHoverPrimary: '#CCCCCC',
    colorPressedPrimary: '#CCCCCC',
  },
  Input: {
    color: '#1F1F1F', // --surface-2 (dark) — 输入框底
    colorFocus: '#1F1F1F',
    border: '1px solid #262626',
    borderHover: '1px solid #666666',
    borderFocus: '1px solid #FFFFFF',
    borderDisabled: '1px solid #262626',
    groupLabelBorder: '1px solid #262626',
    placeholderColor: '#333333', // --fg-disabled (dark)
    caretColor: '#FFFFFF',
  },
  InternalSelection: {
    border: '1px solid #262626',
    borderHover: '1px solid #666666',
    borderActive: '1px solid #FFFFFF',
    borderFocus: '1px solid #FFFFFF',
  },
  Card: {
    color: '#0D0D0D', // cards sit on the ground with a ring, like light mode
    borderColor: '#262626',
  },
  Modal: {
    color: '#0D0D0D',
  },
  Tag: {
    borderRadius: '2px', // --r-ctl — a tag is a small control, not a card
  },
  Switch: {
    // Prototype Toggle off = raw --gray-cc, which the DS never remaps in
    // dark — the rail stays the same in both themes.
    railColor: '#CCCCCC',
    // On = --hue-purple, not --keep-green. See KpToggle / the light block above.
    railColorActive: '#6D51F4', // --hue-purple
    loadingColor: '#FFFFFF',
    opacityDisabled: 0.4,
    // Prototype Toggle: 38x22 track, 18px knob, 2px inset
    railHeightSmall: '22px',
    railWidthSmall: '38px',
    buttonHeightSmall: '18px',
    buttonWidthSmall: '18px',
    railHeightMedium: '22px',
    railWidthMedium: '38px',
    buttonHeightMedium: '18px',
    buttonWidthMedium: '18px',
  },
}

export function getThemeOverrides(isDark: boolean, isComic?: boolean): GlobalThemeOverrides {
  const base = isDark ? darkThemeOverrides : lightThemeOverrides
  if (!isComic) return base
  const comicFont = "'Comic Neue', 'ZCOOL KuaiLe', 'Zen Maru Gothic', 'Gaegu', cursive, sans-serif"
  return {
    ...base,
    common: {
      ...base.common!,
      fontFamily: comicFont,
    },
  }
}
