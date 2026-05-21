import assert from 'assert';
import { escapeHTML, sanitizeHTML, isChatAuthorized, isRateLimited, resetRateLimits, splitHTMLText, log } from './utils.js';

function runTests(): void {
  console.log("Starting utility tests...");

  // 1. Test escapeHTML
  console.log("Testing escapeHTML...");
  assert.strictEqual(escapeHTML("hello & world"), "hello &amp; world");
  assert.strictEqual(escapeHTML("3 < 5"), "3 &lt; 5");
  assert.strictEqual(escapeHTML("5 > 3"), "5 &gt; 3");
  assert.strictEqual(escapeHTML("<html>"), "&lt;html&gt;");
  assert.strictEqual(escapeHTML(""), "");
  assert.strictEqual(escapeHTML("plain text"), "plain text");
  console.log("  Passed escapeHTML tests.");

  // 2. Test sanitizeHTML
  console.log("Testing sanitizeHTML...");
  assert.strictEqual(sanitizeHTML("<b>bold</b>"), "<b>bold</b>");
  assert.strictEqual(sanitizeHTML("<i>italic</i>"), "<i>italic</i>");
  assert.strictEqual(sanitizeHTML("<code>code</code>"), "<code>code</code>");
  assert.strictEqual(sanitizeHTML("<pre>pre</pre>"), "<pre>pre</pre>");

  assert.strictEqual(sanitizeHTML("<B>bold</B>"), "<b>bold</b>");
  assert.strictEqual(sanitizeHTML("<i class='test'>italic</i>"), "<i>italic</i>");
  assert.strictEqual(sanitizeHTML("<CODE id=\"mycode\">code</CODE>"), "<code>code</code>");

  assert.strictEqual(
    sanitizeHTML("<script>alert(1)</script>"), 
    "&lt;script&gt;alert(1)&lt;/script&gt;"
  );
  assert.strictEqual(
    sanitizeHTML("<div>test</div>"), 
    "&lt;div&gt;test&lt;/div&gt;"
  );

  assert.strictEqual(
    sanitizeHTML("me & you <b>us</b>"), 
    "me &amp; you <b>us</b>"
  );
  assert.strictEqual(
    sanitizeHTML("x < y and y > z <i>comparison</i>"), 
    "x &lt; y and y &gt; z <i>comparison</i>"
  );

  assert.strictEqual(sanitizeHTML("hello <b tag"), "hello &lt;b tag");
  assert.strictEqual(sanitizeHTML("<>"), "&lt;&gt;");
  assert.strictEqual(sanitizeHTML("</>"), "&lt;/&gt;");
  assert.strictEqual(sanitizeHTML("<123>"), "&lt;123&gt;");
  console.log("  Passed sanitizeHTML tests.");

  // 3. Test isChatAuthorized
  console.log("Testing isChatAuthorized...");
  // Default disabled (allowed)
  delete process.env.ALLOWED_CHATS;
  assert.strictEqual(isChatAuthorized(123), true);
  assert.strictEqual(isChatAuthorized(-100123), true);

  // Specific whitelist
  process.env.ALLOWED_CHATS = "123, -100456, 789";
  assert.strictEqual(isChatAuthorized(123), true);
  assert.strictEqual(isChatAuthorized(-100456), true);
  assert.strictEqual(isChatAuthorized(789), true);
  assert.strictEqual(isChatAuthorized(999), false);
  assert.strictEqual(isChatAuthorized(-100123), false);

  // Empty whitelist defaults to allowed
  process.env.ALLOWED_CHATS = "";
  assert.strictEqual(isChatAuthorized(123), true);
  console.log("  Passed isChatAuthorized tests.");

  // 4. Test isRateLimited
  console.log("Testing isRateLimited...");
  // Default disabled
  delete process.env.RATE_LIMIT_MAX_REQUESTS;
  resetRateLimits();
  assert.strictEqual(isRateLimited(111).limited, false);
  assert.strictEqual(isRateLimited(111).limited, false);

  // Enforced limits
  process.env.RATE_LIMIT_MAX_REQUESTS = "2";
  process.env.RATE_LIMIT_WINDOW_SEC = "10";
  resetRateLimits();

  // First 2 requests succeed
  assert.strictEqual(isRateLimited(111).limited, false);
  assert.strictEqual(isRateLimited(111).limited, false);
  // Third request is rate-limited
  const result = isRateLimited(111);
  assert.strictEqual(result.limited, true);
  assert.ok((result.retryAfter || 0) > 0 && (result.retryAfter || 0) <= 10);

  // Other chats are not affected
  assert.strictEqual(isRateLimited(222).limited, false);

  // Reset clears limits
  resetRateLimits();
  assert.strictEqual(isRateLimited(111).limited, false);
  console.log("  Passed isRateLimited tests.");

  // 5. Test splitHTMLText
  console.log("Testing splitHTMLText...");
  // Plain text splitting
  assert.deepStrictEqual(splitHTMLText("abcdef", 3), ["abc", "def"]);
  assert.deepStrictEqual(splitHTMLText("abcdef", 4), ["abcd", "ef"]);

  // Tag preservation - fits in length
  assert.deepStrictEqual(splitHTMLText("<b>hello</b>", 12), ["<b>hello</b>"]);

  // Tag preservation - needs split
  // For '<b>hello world</b>', if maxLength = 15:
  // First chunk: '<b>hello </b>' (14 chars)
  // Second chunk: '<b>world</b>' (12 chars)
  const textToSplit = "<b>hello world</b>";
  const splitChunks = splitHTMLText(textToSplit, 15);
  assert.deepStrictEqual(splitChunks, ["<b>hello </b>", "<b>world</b>"]);

  // Test nesting tags preservation
  // '<b><i>nested</i></b>' split at small length
  const nestedText = "<b><i>hello</i> <i>world</i></b>";
  const nestedChunks = splitHTMLText(nestedText, 25);
  // '<b><i>hello</i> </b>' is 19 chars
  // '<b><i>world</i></b>' is 18 chars
  assert.deepStrictEqual(nestedChunks, ["<b><i>hello</i> <i></i></b>", "<b><i>world</i></b>"]);

  // Test long text split with tags
  const longTextWithTags = "<code>" + "a".repeat(10) + " " + "b".repeat(10) + "</code>";
  // '<code>aaaaaaaaaa bbbbbbbbbb</code>'
  // Let's split it at maxLength = 22
  // '<code>aaaaaaaaaa </code>' (23 chars) -> wait, 6 (<code>) + 11 (aaaaaaaaaa ) + 7 (</code>) = 24 chars > 22.
  // Let's check with maxLength = 25
  const longSplit = splitHTMLText(longTextWithTags, 25);
  assert.deepStrictEqual(longSplit, [
    "<code>aaaaaaaaaa </code>",
    "<code>bbbbbbbbbb</code>"
  ]);

  console.log("  Passed splitHTMLText tests.");

  // 6. Test log helper (DEBUG logging filtering)
  console.log("Testing log helper...");
  const originalConsoleLog = console.log;
  let loggedMessages: string[] = [];
  console.log = (...args: any[]) => {
    loggedMessages.push(args.join(" "));
  };

  try {
    // With DEBUG disabled by default
    delete process.env.DEBUG;
    delete process.env.LOG_LEVEL;
    log("INFO", "Info message test");
    log("DEBUG", "Debug message test");

    assert.ok(loggedMessages.some(msg => msg.includes("[INFO] Info message test")), "INFO message should be logged");
    assert.ok(!loggedMessages.some(msg => msg.includes("[DEBUG] Debug message test")), "DEBUG message should NOT be logged by default");

    // Clear buffer
    loggedMessages = [];

    // With DEBUG enabled
    process.env.DEBUG = "true";
    log("INFO", "Second info message test");
    log("DEBUG", "Second debug message test");

    assert.ok(loggedMessages.some(msg => msg.includes("[INFO] Second info message test")), "INFO message should be logged when DEBUG is true");
    assert.ok(loggedMessages.some(msg => msg.includes("[DEBUG] Second debug message test")), "DEBUG message should be logged when DEBUG is true");

    // Clear buffer
    loggedMessages = [];

    // With LOG_LEVEL=debug
    delete process.env.DEBUG;
    process.env.LOG_LEVEL = "debug";
    log("DEBUG", "Third debug message test");

    assert.ok(loggedMessages.some(msg => msg.includes("[DEBUG] Third debug message test")), "DEBUG message should be logged when LOG_LEVEL is debug");

  } finally {
    // Restore console.log and clean up env vars
    console.log = originalConsoleLog;
    delete process.env.DEBUG;
    delete process.env.LOG_LEVEL;
  }
  console.log("  Passed log helper tests.");

  console.log("✅ All utility tests passed successfully!");
}

runTests();
