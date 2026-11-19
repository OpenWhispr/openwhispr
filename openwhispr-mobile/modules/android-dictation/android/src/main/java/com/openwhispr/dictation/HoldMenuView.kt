package com.openwhispr.dictation

import android.content.Context
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/** A row's 28 dp tile with its filled 14 dp glyph. */
private class MenuTile(context: Context, private val mode: BubbleMode) : View(context) {
  private val tile = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.tile }
  private val glyph = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.ink }
  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
  override fun onDraw(canvas: Canvas) {
    val radius = width * 9f / 28f
    canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), radius, radius, tile)
    BubbleGlyphs.draw(canvas, mode, width / 2f, height / 2f, width / 2f, glyph)
  }
}

/** The text the menu needs, already in the phone's language. */
data class MenuCopy(
  val title: (BubbleMode) -> String,
  val subtitle: (BubbleMode) -> String,
  /** The second line of a greyed row ("Sign in to use"). */
  val blockedReason: String,
)

/**
 * V3/Menu: a white card with the glass edge, rows for Assistant, Translate and (with text selected)
 * Edit selection. Drawn inside the bubble's own window, which never takes focus, so the text box keeps
 * its caret and selection. A row lights up under a sliding finger.
 */
class HoldMenuView(
  context: Context, regular: Typeface, medium: Typeface, val rows: List<MenuRow>, copy: MenuCopy,
  /** Size & look's size, as for the bubble (BubbleMenuPolicy.menuScale). */
  private val scale: Float = 1f,
) : LinearLayout(context) {
  private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics) * scale
  val padding = dp(6f)
  val rowHeight = dp(44f)
  val gap = dp(2f)
  private val rowViews = mutableListOf<LinearLayout>()
  var highlighted: Int? = null
    set(value) {
      if (field == value) return
      field = value
      rowViews.forEachIndexed { index, row ->
        row.background = if (index == value) GradientDrawable().apply {
          setColor(Color.argb(31, Color.red(BubbleColors.brand), Color.green(BubbleColors.brand), Color.blue(BubbleColors.brand)))
          cornerRadius = dp(14f)
        } else null
      }
      if (value != null) performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
    }
  var onPick: ((Int) -> Unit)? = null

  init {
    orientation = VERTICAL
    val pad = padding.toInt(); setPadding(pad, pad, pad, pad)
    background = GradientDrawable().apply {
      setColor(Color.WHITE); cornerRadius = dp(20f); setStroke(dp(1f).toInt().coerceAtLeast(1), BubbleColors.hairline)
    }
    elevation = dp(4f)
    rows.forEachIndexed { index, row ->
      val line = LinearLayout(context).apply {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(8f).toInt(), 0, dp(10f).toInt(), 0)
        alpha = if (row.enabled) 1f else 0.45f
        isClickable = true
        contentDescription = "${copy.title(row.mode)}, ${if (row.enabled) copy.subtitle(row.mode) else copy.blockedReason}"
        setOnClickListener { onPick?.invoke(index) }
      }
      line.addView(MenuTile(context, row.mode), LayoutParams(dp(28f).toInt(), dp(28f).toInt()))
      val words = LinearLayout(context).apply { orientation = VERTICAL; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS }
      words.addView(text(copy.title(row.mode), medium, 14f, BubbleColors.ink))
      words.addView(text(if (row.enabled) copy.subtitle(row.mode) else copy.blockedReason, regular, 12f, BubbleColors.secondary))
      line.addView(words, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(10f).toInt() })
      addView(line, LayoutParams(dp(196f).toInt(), rowHeight.toInt()).apply { if (index > 0) topMargin = gap.toInt() })
      rowViews += line
    }
  }

  private fun text(value: String, face: Typeface, size: Float, color: Int) = TextView(context).apply {
    text = value; typeface = face; setTextColor(color); setTextSize(TypedValue.COMPLEX_UNIT_SP, size * scale)
    maxLines = 1; ellipsize = TextUtils.TruncateAt.END; includeFontPadding = false
  }

  /** The row under a finger at screen point ([rawX], [rawY]), or null. */
  fun rowAtScreen(rawX: Float, rawY: Float): Int? {
    val at = IntArray(2); getLocationOnScreen(at)
    return BubbleMenuPolicy.rowAt(rawY - at[1], rawX - at[0], width.toFloat(), rows, padding, rowHeight, gap)
  }

  /** Grows out of the bubble's corner: scale 0.8 → 1 with a spring, the rows fading in 30 ms apart. */
  fun grow(fromRight: Boolean) {
    pivotX = if (fromRight) width.toFloat().takeIf { it > 0 } ?: dp(208f) else 0f
    pivotY = height.toFloat().takeIf { it > 0 } ?: (padding * 2 + rows.size * (rowHeight + gap))
    scaleX = 0.8f; scaleY = 0.8f; alpha = 0f
    animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(220).setInterpolator(android.view.animation.OvershootInterpolator(0.8f)).start()
    rowViews.forEachIndexed { index, row ->
      row.alpha = 0f
      row.animate().alpha(if (rows[index].enabled) 1f else 0.45f).setStartDelay(40L + index * 30L).setDuration(120).start()
    }
  }
}
