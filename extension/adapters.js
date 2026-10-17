// FreeHarness 站点适配器
// 每个适配器提供：
//   name           站点名
//   test()         hostname 是否匹配
//   lastAssistant() 取最新一条 AI 消息的纯文本（找不到返回 null）
//   isGenerating()  可选：AI 是否正在生成（有停止按钮）
//   input()        输入框元素
//   fill(el, text) 填入文本（React 受控组件兼容）
//   send()         点击发送按钮（成功返回 true，返回 false 则主脚本回退用 Enter）
//
// DOM 随时可能改版：选择器全部用「候选列表」，失效时按 README 添加新选择器即可。
(function (root) {
  function lastTextOf(selectors) {
    var list = Array.isArray(selectors) ? selectors : [selectors];
    for (var i = 0; i < list.length; i++) {
      var nodes = document.querySelectorAll(list[i]);
      // 从后往前扫：文档顺序最后一个元素可能是图标/装饰（如 SVG，无文本），
      // 只看最后一个会把真消息堵死——跳过空文本元素，取第一个有内容的（即最新一条真消息）
      for (var k = nodes.length - 1; k >= 0; k--) {
        var n = nodes[k];
        // 剔除思考/推理区块（模型内心戏，其中的 [TOOL_CALL] 绝不能执行）：
        // 类名匹配 think/reasoning 的子树。克隆节点再删，绝不碰真实 DOM。
        var clone = n.cloneNode(true);
        var think = clone.querySelectorAll('[class*="think"], [class*="Think"], [class*="reasoning"], [class*="Reasoning"]');
        for (var j = think.length - 1; j >= 0; j--) {
          if (think[j].parentNode) think[j].parentNode.removeChild(think[j]);
        }
        var t = (clone.innerText || clone.textContent || "").trim();
        if (t) return t;
      }
    }
    return null;
  }

  function firstVisible(selectors) {
    var list = Array.isArray(selectors) ? selectors : [selectors];
    for (var i = 0; i < list.length; i++) {
      var nodes = document.querySelectorAll(list[i]);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        var r = el.getBoundingClientRect();
        var visible = r.width > 8 && r.height > 8;
        var editable = el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable;
        if (visible && editable && !el.disabled) return el;
      }
    }
    return null;
  }

  // 点击第一个可见且可用的按钮
  function clickButton(selectors) {
    var list = Array.isArray(selectors) ? selectors : [selectors];
    for (var i = 0; i < list.length; i++) {
      var nodes;
      try { nodes = document.querySelectorAll(list[i]); } catch (e) { continue; }
      for (var j = 0; j < nodes.length; j++) {
        var b = nodes[j];
        var r = b.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
        b.click();
        return true;
      }
    }
    return false;
  }

  // 通用填入：textarea/input 走原生 setter，contenteditable 走 execCommand
  async function fillControl(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      var proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      var ok = document.execCommand("insertText", false, text);
      if (!ok || (el.textContent || "").length < Math.floor(text.length * 0.5)) {
        // 兜底：直接改内容 + input 事件（部分站点不生效）
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      }
    }
  }

  var ADAPTERS = [
    {
      name: "ChatGPT",
      test: function (h) { return /(^|\.)chatgpt\.com$/.test(h) || /(^|\.)openai\.com$/.test(h); },
      lastAssistant: function () { return lastTextOf('[data-message-author-role="assistant"]'); },
      isGenerating: function () {
        return !!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop"]');
      },
      input: function () { return firstVisible(['#prompt-textarea', 'textarea', '[contenteditable="true"]']); },
      fill: fillControl,
      send: function () {
        return clickButton(['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]']);
      }
    },
    {
      name: "Claude",
      test: function (h) { return /(^|\.)claude\.ai$/.test(h); },
      lastAssistant: function () {
        return lastTextOf(['div.font-claude-message', '[data-testid="assistant-message"]', '[data-is-streaming]']);
      },
      isGenerating: function () {
        return !!document.querySelector('button[aria-label="Stop streaming"], button[data-testid="stop-button"], button[aria-label="Stop response"]');
      },
      input: function () { return firstVisible(['div[contenteditable="true"].ProseMirror', 'div.ProseMirror', '[contenteditable="true"]']); },
      fill: fillControl,
      send: function () {
        return clickButton(['button[aria-label="Send message"]', 'button[data-testid="send-button"]', 'button[aria-label="Send"]', 'button[type="submit"]']);
      }
    },
    {
      name: "Kimi",
      test: function (h) { return /(^|\.)moonshot\.cn$/.test(h) || /(^|\.)kimi\.com$/.test(h); },
      lastAssistant: function () {
        return lastTextOf(['.agent-chat__msg__content', '[class*="agent-chat__item"] [class*="content"]', '.markdown-body']);
      },
      isGenerating: function () {
        return !!document.querySelector('.stop-btn, button[class*="stop"]');
      },
      input: function () { return firstVisible(['textarea.textarea', '.ace_text-input', 'textarea']); },
      fill: fillControl,
      send: function () {
        return clickButton(['.send-button', 'button[class*="send"]', '[class*="sendBtn"]']);
      }
    },
    {
      name: "DeepSeek",
      test: function (h) { return /(^|\.)deepseek\.com$/.test(h); },
      lastAssistant: function () {
        return lastTextOf(['.ds-markdown.ds-markdown--block', '.ds-markdown']);
      },
      isGenerating: function () {
        return !!document.querySelector('div[role="button"][class*="stop"], button[class*="stop"]');
      },
      input: function () { return firstVisible(['textarea#chat-input', 'textarea']); },
      fill: fillControl,
      send: function () {
        return clickButton(['div[role="button"][aria-label*="发送"]', 'button[class*="send"]']);
      }
    },
    {
      name: "通义千问",
      test: function (h) { return /(^|\.)aliyun\.com$/.test(h) || /(^|\.)tongyi\.com$/.test(h); },
      lastAssistant: function () {
        return lastTextOf(['[class*="answer"] .tongyi-markdown', '.tongyi-markdown', '[class*="answer-container"]', '[class*="markdown-body"]']);
      },
      isGenerating: function () {
        return !!document.querySelector('button[class*="stop"], [class*="stop-btn"]');
      },
      input: function () { return firstVisible(['textarea', '[contenteditable="true"]']); },
      fill: fillControl,
      send: function () {
        return clickButton(['button[class*="send"]', '[class*="sendBtn"]', 'button[class*="operate"]']);
      }
    },
    {
      name: "智谱清言",
      test: function (h) { return /(^|\.)chatglm\.cn$/.test(h) || /(^|\.)bigmodel\.cn$/.test(h) || /(^|\.)z\.ai$/.test(h); },
      lastAssistant: function () {
        return lastTextOf(['[class*="assistant"] .md', '.md', '[class*="markdown"]']);
      },
      isGenerating: function () {
        return !!document.querySelector('button[class*="stop"]');
      },
      input: function () { return firstVisible(['textarea', '[contenteditable="true"]']); },
      fill: fillControl,
      send: function () {
        return clickButton(['button[class*="send"]', '[class*="sendBtn"]']);
      }
    },
    {
      name: "腾讯元宝",
      test: function (h) { return /(^|\.)yuanbao\.tencent\.com$/.test(h); },
      lastAssistant: function () {
        return lastTextOf(['[class*="agent-chat__item"] [class*="content"]', '[class*="bubble-rich-text"]', '[class*="markdown"]']);
      },
      isGenerating: function () {
        return !!document.querySelector('button[class*="stop"]');
      },
      input: function () { return firstVisible(['[contenteditable="true"]', 'textarea']); },
      fill: fillControl,
      send: function () {
        return clickButton(['button[class*="send"]', '[class*="sendBtn"]']);
      }
    },
    {
      name: "豆包",
      test: function (h) { return /(^|\.)doubao\.com$/.test(h); },
      lastAssistant: function () {
        return lastTextOf(['[data-testid="receive_message"]', '[class*="receive"]', '[class*="markdown"]']);
      },
      isGenerating: function () {
        return !!document.querySelector('button[class*="stop"]');
      },
      input: function () { return firstVisible(['[contenteditable="true"]', 'textarea']); },
      fill: fillControl,
      send: function () {
        return clickButton(['button[class*="send"]', '[class*="sendBtn"]']);
      }
    },
    {
      name: "Gemini",
      test: function (h) { return /(^|\.)gemini\.google\.com$/.test(h); },
      lastAssistant: function () {
        return lastTextOf(['.markdown.main-content', 'main [class*="model"] .markdown', '.markdown']);
      },
      isGenerating: function () {
        return !!document.querySelector('button[aria-label="Stop"], mat-icon[fonticon="stop"]');
      },
      input: function () { return firstVisible(['rich-textarea div[contenteditable="true"]', '.ql-editor[contenteditable="true"]', '[contenteditable="true"]']); },
      fill: fillControl,
      send: function () {
        return clickButton(['button.send-button', 'button[aria-label="Send message"]', 'button[aria-label*="发送"]']);
      }
    }
  ];

  // 通用兜底适配器（未专门适配的站点，启发式抓取，可能不准）
  var GENERIC = {
    name: "通用(启发式)",
    lastAssistant: function () {
      var t = lastTextOf([
        '[data-message-author-role="assistant"]',
        '[data-testid="assistant-message"]',
        '[class*="assistant" i] [class*="markdown" i]',
        '.markdown-body',
        '[class*="markdown" i]',
        'article'
      ]);
      if (t && t.length >= 40) return t;
      return null;
    },
    isGenerating: function () {
      return !!document.querySelector('[data-testid="stop-button"], [aria-label*="Stop" i], [aria-label*="停止"], button[class*="stop" i]');
    },
    input: function () { return firstVisible(['#prompt-textarea', 'textarea', '[contenteditable="true"]']); },
    fill: fillControl,
    send: function () {
      return clickButton([
        'button[data-testid="send-button"]', '[aria-label*="Send" i]', '[aria-label*="发送"]',
        'button[class*="send" i]', '[class*="sendBtn" i]'
      ]);
    }
  };

  function getAdapter() {
    var h = location.hostname;
    for (var i = 0; i < ADAPTERS.length; i++) {
      try { if (ADAPTERS[i].test(h)) return ADAPTERS[i]; } catch (e) {}
    }
    return GENERIC;
  }

  root.WHAdapters = { getAdapter: getAdapter, fillControl: fillControl, ADAPTERS: ADAPTERS, GENERIC: GENERIC };
})(window);
