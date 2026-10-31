package com.openwhispr.androidtest;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Separate-process, unsent fields for exercising the real Accessibility service. */
public class FixtureActivity extends Activity {
  private EditText primary;
  private EditText secondary;
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    layout.setPadding(40, 180, 40, 40);
    TextView title = new TextView(this);
    title.setText("OpenWhispr insertion test — nothing is sent");
    title.setTextSize(22);
    layout.addView(title);
    primary = new EditText(this);
    primary.setContentDescription("primary test field");
    primary.setHint("Your message");
    secondary = new EditText(this);
    secondary.setContentDescription("secondary test field");
    secondary.setHint("Another message");
    layout.addView(primary);
    layout.addView(secondary);
    setContentView(layout);
    apply(getIntent());
  }
  @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); apply(intent); }
  private void apply(Intent intent) {
    if (intent.hasExtra("text")) {
      primary.setInputType(InputType.TYPE_CLASS_TEXT | (intent.getBooleanExtra("password", false)
        ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_MULTI_LINE));
      primary.setText(intent.getStringExtra("text"));
      primary.requestFocus();
      primary.setSelection(intent.getIntExtra("start", primary.length()), intent.getIntExtra("end", primary.length()));
    }
    if (intent.getBooleanExtra("other", false)) secondary.requestFocus();
  }
}
