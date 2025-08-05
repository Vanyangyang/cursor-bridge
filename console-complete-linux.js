// Cursor完整客户端 - 最终修复版
// 修复了以下关键问题：
// 1. 复制按钮查找逻辑（不再假设在倒数第二个div）
// 2. 消息完成检测（优先检查复制按钮，备用检查文本内容）
// 3. Linux下opacity空值处理
// 4. 简短消息的内容检测

(function () {
    'use strict';

    // 防止重复注入
    if (window.cursorClientInitialized) {
        console.error('⚠️ Cursor客户端已经初始化，跳过重复注入');
        return;
    }
    window.cursorClientInitialized = true;

    // 清理之前的实例
    if (window.cursorClient && window.cursorClient.ws) {
        console.error('🔄 清理之前的WebSocket连接...');
        window.cursorClient.ws.close();
        window.cursorClient = null;
    }

    console.error('🎯 Cursor完整客户端启动（最终版）...');

    // ============== 精确注入器部分 ==============
    window.cursorPreciseInjector = {
        // 精确选择器
        selectors: {
            input: '.aislash-editor-input[contenteditable="true"][data-lexical-editor="true"]',
            sendButtonContainer: '.anysphere-icon-button[data-variant="background"]',
            completeFlag: '.anysphere-icon-button .codicon-copy-two',
        },

        findInputElement: function () {
            // 尝试多个选择器，从严格到宽松
            const selectors = [
                this.selectors.input,
                '.aislash-editor-input[contenteditable="true"]',
                '.aislash-editor-input[data-lexical-editor="true"]',
                '.aislash-editor-input',
                '[contenteditable="true"][data-lexical-editor="true"]'
            ];

            for (const selector of selectors) {
                const input = document.querySelector(selector);
                if (input) {
                    console.error('✅ 找到输入框，使用选择器:', selector);
                    return input;
                }
            }

            console.error('❌ 未找到输入框，尝试过的选择器:', selectors);
            return null;
        },

        findSendButton: function () {
            const selectors = [
                '.anysphere-icon-button .codicon-arrow-up-two',
                '.codicon-arrow-up-two',
                '.anysphere-icon-button[data-variant="background"]',
                'div.anysphere-icon-button'
            ];

            for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (element) {
                    const button = element.classList.contains('anysphere-icon-button')
                        ? element
                        : element.closest('.anysphere-icon-button');

                    if (button) {
                        console.error('✅ 找到发送按钮:', selector);
                        return button;
                    }
                }
            }

            console.error('❌ 未找到发送按钮');
            return null;
        },

        setLexicalText: function (element, text) {
            console.error('📝 设置文本...');

            try {
                element.focus();
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(element);
                selection.removeAllRanges();
                selection.addRange(range);

                const success = document.execCommand('insertText', false, text);

                if (success) {
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    console.error('✅ 文本设置成功');
                    return true;
                }

                throw new Error('execCommand失败');

            } catch (error) {
                // 备用方法
                try {
                    element.focus();
                    const p = document.createElement('p');
                    p.setAttribute('dir', 'ltr');
                    const span = document.createElement('span');
                    span.setAttribute('data-lexical-text', 'true');
                    span.textContent = text;
                    p.appendChild(span);
                    // 清空元素内容
                    while (element.firstChild) {
                        element.removeChild(element.firstChild);
                    }
                    element.appendChild(p);
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    console.error('✅ 文本设置成功（备用方法）');
                    return true;
                } catch (backupError) {
                    console.error('❌ 设置文本失败');
                    return false;
                }
            }
        },

        clickSendButton: function (button) {
            console.error('🚀 点击发送按钮...');

            try {
                // 检查按钮状态
                const isDisabled = button.hasAttribute('data-disabled') &&
                    button.getAttribute('data-disabled') === 'true';

                if (isDisabled) {
                    console.error('⚠️ 发送按钮被禁用');
                    return false;
                }

                // 触发点击事件
                button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

                console.error('✅ 点击事件已触发');
                return true;

            } catch (error) {
                console.error('❌ 点击失败:', error.message);
                return false;
            }
        },

        // 获取当前最大消息索引
        getCurrentMaxMessageIndex: function () {
            const messageElements = document.querySelectorAll('[data-message-index]');
            let maxIndex = -1;

            messageElements.forEach(el => {
                const index = parseInt(el.getAttribute('data-message-index'), 10);
                if (!isNaN(index) && index > maxIndex) {
                    maxIndex = index;
                }
            });

            return maxIndex;
        },

        // 检查复制按钮是否真正可见
        isCopyButtonTrulyVisible: function (copyButton) {
            if (!copyButton) {
                return false;
            }

            // 1. 基础可见性检查
            const rect = copyButton.getBoundingClientRect();
            const hasSize = rect.width > 0 && rect.height > 0;
            const isInDOM = copyButton.offsetParent !== null;

            if (!hasSize || !isInDOM) {
                return false;
            }

            // 2. 检查基本样式可见性（智能处理opacity）
            const style = window.getComputedStyle(copyButton);
            const opacity = parseFloat(style.opacity) || 1; // 如果opacity为空，默认为1
            const isStyleVisible = style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                opacity > 0.1;

            if (!isStyleVisible) {
                return false;
            }

            // 3. 检查直接父容器（只检查1层，忽略opacity）
            const parent = copyButton.parentElement;
            if (parent && parent !== document.body) {
                const parentStyle = window.getComputedStyle(parent);
                const parentVisible = parentStyle.display !== 'none' &&
                    parentStyle.visibility !== 'hidden';

                if (!parentVisible) {
                    return false;
                }
            }

            return true;
        },

        // 等待新消息出现（等待AI回复）
        waitForNewMessage: function (initialMaxIndex, timeout = 600000) {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();

                const checkInterval = setInterval(() => {
                    const currentMaxIndex = this.getCurrentMaxMessageIndex();

                    // 需要等待至少2条新消息：用户消息+AI回复
                    if (currentMaxIndex > initialMaxIndex + 1) {
                        console.error(`✅ 检测到AI回复消息 index: ${currentMaxIndex}`);
                        clearInterval(checkInterval);
                        resolve(currentMaxIndex);
                        return;
                    } else if (currentMaxIndex > initialMaxIndex) {
                        console.error(`📝 检测到用户消息 index: ${currentMaxIndex}，继续等待AI回复...`);
                    }

                    // 检查超时
                    if (Date.now() - startTime > timeout) {
                        clearInterval(checkInterval);
                        reject(new Error('等待新消息超时'));
                        return;
                    }
                }, 500);
            });
        },

        // 检查消息是否还在生成中（修复版）
        isMessageGenerating: function (messageElement) {
            // 1. 检查是否是用户消息
            const isUserMessage = messageElement.querySelector('.composer-human-message');
            if (isUserMessage) {
                return false;
            }

            // 2. 检查是否有"Generating..."文本
            const text = messageElement.textContent || '';
            if (text.includes('Generating') || text.includes('生成中')) {
                return true;
            }

            // 3. 检查是否有加载动画元素
            const loadingElements = messageElement.querySelectorAll('[class*="loading"], [class*="generating"], [class*="spinner"]');
            if (loadingElements.length > 0) {
                return true;
            }

            // 4. 最重要：检查复制按钮是否存在且可见
            const copyButton = this.findCopyButtonForMessage(messageElement);
            if (copyButton && this.isCopyButtonTrulyVisible(copyButton)) {
                return false; // 有可见的复制按钮 = 消息已完成
            }

            // 5. 备用：如果有任何文本内容，也认为完成
            const contentLength = (messageElement.textContent || '').trim().length;
            if (contentLength > 0) {
                return false; // 有内容 = 消息已完成
            }

            return true; // 默认认为还在生成
        },

        // 为特定消息查找复制按钮（修复版）
        findCopyButtonForMessage: function (messageElement) {
            // 步骤1：找到消息容器
            let messageContainer = messageElement;
            if (!messageContainer.hasAttribute('data-message-index')) {
                messageContainer = messageContainer.closest('[data-message-index]');
            }

            if (!messageContainer) {
                return null;
            }

            // 步骤2：找到父容器
            const parentContainer = messageContainer.parentElement;
            if (!parentContainer) {
                return null;
            }

            // 步骤3：遍历所有子元素查找包含复制按钮的div
            const childDivs = Array.from(parentContainer.children);

            for (let i = 0; i < childDivs.length; i++) {
                const div = childDivs[i];
                // 跳过消息容器本身
                if (div === messageContainer) {
                    continue;
                }

                // 查找复制按钮
                const copyButton = div.querySelector('.codicon-copy-two');
                if (copyButton) {
                    // 检查按钮可见性
                    const buttonContainer = copyButton.closest('div[class*="anysphere-icon-button"]') || copyButton.parentElement;
                    if (buttonContainer) {
                        const style = getComputedStyle(buttonContainer);
                        const opacity = parseFloat(style.opacity) || 1;

                        if (opacity > 0.1) {
                            return copyButton;
                        }
                    } else {
                        // 没有容器，直接返回按钮
                        return copyButton;
                    }
                }
            }

            // 备用方案：直接在父容器中查找所有复制按钮
            const allCopyButtons = parentContainer.querySelectorAll('.codicon-copy-two');
            if (allCopyButtons.length > 0) {
                // 返回最后一个（通常是最新的）
                for (let i = allCopyButtons.length - 1; i >= 0; i--) {
                    const btn = allCopyButtons[i];
                    const buttonContainer = btn.closest('div[class*="anysphere-icon-button"]') || btn.parentElement;
                    if (buttonContainer) {
                        const style = getComputedStyle(buttonContainer);
                        const opacity = parseFloat(style.opacity) || 1;
                        if (opacity > 0.1) {
                            return btn;
                        }
                    } else {
                        return btn;
                    }
                }
            }

            return null;
        },

        // 🎯 基于按钮状态的等待完成方法（改进版）
        waitForButtonComplete: function (timeout = 600000) {
            console.error('⏳ 等待按钮状态变化...');

            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                let hasSeenStopButton = false;
                let lastButtonState = null;
                let stateHistory = [];

                const checkInterval = setInterval(() => {
                    // 更精确的按钮查找：先找图标，再找按钮
                    let button = null;
                    let icon = null;

                    // 优先查找带有箭头或停止图标的按钮
                    const arrowIcon = document.querySelector('.codicon-arrow-up-two');
                    const stopIcon = document.querySelector('.codicon-debug-stop');

                    if (stopIcon) {
                        icon = stopIcon;
                        button = stopIcon.closest('.anysphere-icon-button');
                    } else if (arrowIcon) {
                        icon = arrowIcon;
                        button = arrowIcon.closest('.anysphere-icon-button');
                    }

                    if (!button || !icon) {
                        // 备用：查找任何按钮
                        button = document.querySelector('.anysphere-icon-button');
                        if (button) {
                            icon = button.querySelector('[class*="codicon"]');
                        }
                    }

                    if (!button || !icon) {
                        console.error('❌ 未找到发送按钮');
                        return;
                    }

                    const iconClass = icon.className;
                    const isDisabled = button.getAttribute('data-disabled') === 'true';
                    const currentState = `${iconClass.match(/codicon-[\w-]+/)?.[0] || 'unknown'}_${isDisabled ? 'disabled' : 'enabled'}`;

                    // 记录状态变化
                    if (currentState !== lastButtonState) {
                        const timestamp = new Date().toLocaleTimeString();
                        console.error(`🔄 ${timestamp} 按钮状态: ${currentState}`);
                        stateHistory.push({ time: timestamp, state: currentState });
                        lastButtonState = currentState;
                    }

                    // 检测到停止按钮
                    if (iconClass.includes('codicon-debug-stop')) {
                        hasSeenStopButton = true;
                    }

                    // 完成条件1：从停止按钮变回上箭头
                    if (hasSeenStopButton && iconClass.includes('codicon-arrow-up-two')) {
                        clearInterval(checkInterval);
                        console.error('✅ 检测到按钮从停止变回上箭头，消息完成！');
                        console.error('📊 状态历史:', stateHistory);
                        setTimeout(() => resolve(true), 500);
                        return;
                    }

                    // 完成条件2：上箭头按钮从启用变为禁用（快速发送的情况）
                    if (iconClass.includes('codicon-arrow-up-two') && stateHistory.length >= 2) {
                        const recent = stateHistory.slice(-2);
                        if (recent[0].state.includes('arrow-up-two_enabled') &&
                            recent[1].state.includes('arrow-up-two_disabled')) {
                            clearInterval(checkInterval);
                            console.error('✅ 检测到按钮从启用变为禁用，消息完成！');
                            console.error('📊 状态历史:', stateHistory);
                            setTimeout(() => resolve(true), 500);
                            return;
                        }
                    }

                    // 完成条件3：长时间保持禁用状态（10秒）
                    if (iconClass.includes('codicon-arrow-up-two') && isDisabled) {
                        const disabledDuration = stateHistory
                            .slice()
                            .reverse()
                            .findIndex(s => !s.state.includes('disabled'));

                        if (disabledDuration > 100) { // 100次检查 = 10秒
                            clearInterval(checkInterval);
                            console.error('✅ 按钮长时间保持禁用状态，认为消息已完成');
                            console.error('📊 状态历史:', stateHistory);
                            setTimeout(() => resolve(true), 500);
                            return;
                        }
                    }

                    // 超时检查
                    if (Date.now() - startTime > timeout) {
                        clearInterval(checkInterval);
                        console.error('❌ 等待超时，最后状态:', currentState);
                        console.error('📊 状态历史:', stateHistory);
                        reject(new Error('等待按钮状态超时'));
                    }
                }, 100);
            });
        },

        // 等待指定消息完成
        waitForSpecificMessageComplete: function (targetMessageIndex, timeout = 600000) {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                let consecutiveSuccessCount = 0;
                const requiredSuccessCount = 2;

                console.error(`🎯 等待消息 ${targetMessageIndex} 完成...`);

                const checkInterval = setInterval(() => {
                    const elapsed = Date.now() - startTime;

                    // 检查超时
                    if (elapsed > timeout) {
                        clearInterval(checkInterval);
                        console.error(`❌ 等待消息 ${targetMessageIndex} 超时`);
                        reject(new Error(`等待消息 ${targetMessageIndex} 完成超时`));
                        return;
                    }

                    // 检查指定的消息
                    const targetMessage = document.querySelector(`[data-message-index="${targetMessageIndex}"]`);

                    if (!targetMessage) {
                        consecutiveSuccessCount = 0;
                        return;
                    }

                    // 检查消息是否还在生成状态
                    const isGenerating = this.isMessageGenerating(targetMessage);
                    if (isGenerating) {
                        console.error(`⏳ 消息 ${targetMessageIndex} 还在生成中... (已等待 ${Math.floor(elapsed / 1000)} 秒)`);
                        consecutiveSuccessCount = 0;
                        return;
                    }

                    // 查找复制按钮
                    const copyButton = this.findCopyButtonForMessage(targetMessage);

                    if (copyButton && this.isCopyButtonTrulyVisible(copyButton)) {
                        consecutiveSuccessCount++;
                        console.error(`✅ 消息 ${targetMessageIndex} 复制按钮检查通过 ${consecutiveSuccessCount}/${requiredSuccessCount}`);

                        if (consecutiveSuccessCount >= requiredSuccessCount) {
                            console.error(`🎉 消息 ${targetMessageIndex} 完成！`);
                            clearInterval(checkInterval);
                            resolve();
                            return;
                        }
                    } else {
                        // 备用检测：如果有内容且稳定超过10秒
                        const contentLength = targetMessage.textContent?.length || 0;
                        if (elapsed > 10000 && contentLength > 0) {
                            consecutiveSuccessCount++;
                            if (consecutiveSuccessCount >= requiredSuccessCount) {
                                console.error(`⚠️ 使用备用完成判定（内容稳定）`);
                                clearInterval(checkInterval);
                                resolve();
                                return;
                            }
                        } else {
                            consecutiveSuccessCount = 0;
                        }
                    }
                }, 1000);
            });
        },

        // 等待内容稳定性
        waitForContentStability: function (targetMessageIndex, timeout = 10000) {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                let lastContentHash = null;
                let stableCount = 0;
                const requiredStableCount = 5;

                console.error(`🔄 检查消息 ${targetMessageIndex} 的内容稳定性...`);

                const checkInterval = setInterval(() => {
                    const targetMessage = document.querySelector(`[data-message-index="${targetMessageIndex}"]`);

                    if (!targetMessage) {
                        clearInterval(checkInterval);
                        reject(new Error(`消息 ${targetMessageIndex} 不存在`));
                        return;
                    }

                    // 获取消息的文本内容
                    const currentContent = targetMessage.textContent || '';
                    const currentContentHash = this.hashString(currentContent);

                    if (lastContentHash === null) {
                        lastContentHash = currentContentHash;
                        return;
                    }

                    if (currentContentHash === lastContentHash) {
                        stableCount++;
                        if (stableCount >= requiredStableCount) {
                            console.error(`🎉 消息 ${targetMessageIndex} 内容已稳定！`);
                            clearInterval(checkInterval);
                            resolve();
                            return;
                        }
                    } else {
                        lastContentHash = currentContentHash;
                        stableCount = 0;
                    }

                    // 检查超时
                    if (Date.now() - startTime > timeout) {
                        clearInterval(checkInterval);
                        reject(new Error(`内容稳定性检查超时`));
                        return;
                    }
                }, 2500);
            });
        },

        // 简单字符串哈希函数
        hashString: function (str) {
            let hash = 0;
            if (str.length === 0) return hash;
            for (let i = 0; i < str.length; i++) {
                const char = str.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return hash;
        },

        // 解码HTML实体
        decodeHtmlEntities: function (text) {
            const entities = {
                '&amp;': '&',
                '&lt;': '<',
                '&gt;': '>',
                '&quot;': '"',
                '&#39;': "'",
                '&#x27;': "'",
                '&#x2F;': '/',
                '&#x60;': '`',
                '&#x3D;': '='
            };

            let decoded = text;
            for (const [entity, char] of Object.entries(entities)) {
                decoded = decoded.replace(new RegExp(entity, 'g'), char);
            }

            // 处理数字实体
            decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
                return String.fromCharCode(dec);
            });

            // 处理十六进制实体
            decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
                return String.fromCharCode(parseInt(hex, 16));
            });

            return decoded;
        },

        // 提取指定消息的内容
        extractMessageContent: function (messageIndex) {
            console.error(`📥 提取消息 ${messageIndex} 的内容...`);

            const message = document.querySelector(`[data-message-index="${messageIndex}"]`);
            if (!message) {
                console.error(`❌ 未找到消息 ${messageIndex}`);
                return null;
            }

            // 检查是否是用户消息（跳过）
            const isUserMessage = message.querySelector('.composer-human-message');
            if (isUserMessage) {
                console.error(`👤 消息 ${messageIndex} 是用户消息，跳过`);
                return null;
            }

            // 1. 尝试从markdown-section提取
            const markdownSections = message.querySelectorAll('.markdown-section');
            if (markdownSections.length > 0) {
                const contents = [];
                markdownSections.forEach(section => {
                    const raw = section.getAttribute('data-markdown-raw');
                    if (raw && raw.trim()) {
                        const decodedContent = this.decodeHtmlEntities(raw.trim());
                        contents.push(decodedContent);
                    }
                });

                if (contents.length > 0) {
                    const fullContent = contents.join('\n\n');
                    console.error('✅ 从markdown-section提取内容成功');
                    return fullContent;
                }
            }

            // 2. 备用：提取文本内容
            const markdownContainer = message.querySelector('.anysphere-markdown-container-root');
            if (markdownContainer) {
                const text = markdownContainer.textContent || '';
                if (text.trim()) {
                    console.error('✅ 从text内容提取成功');
                    return text.trim();
                }
            }

            // 3. 最后备用：直接获取消息文本
            const messageText = message.textContent || '';
            if (messageText.trim()) {
                console.error('✅ 从消息文本提取成功');
                return messageText.trim();
            }

            console.error('⚠️ 无法提取消息内容');
            return null;
        },

        sendMessageAndWait: async function (message, timeout = 600000) {
            console.error('🚀 发送消息并等待响应...');
            console.error('📝 消息内容:', message);

            try {
                // 0. 记录当前最大消息索引
                const initialMaxIndex = this.getCurrentMaxMessageIndex();
                console.error('📊 当前最大消息索引:', initialMaxIndex);

                // 1. 查找输入框
                const inputElement = this.findInputElement();
                if (!inputElement) {
                    throw new Error('未找到输入框');
                }

                // 2. 设置文本
                const textSet = this.setLexicalText(inputElement, message);
                if (!textSet) {
                    throw new Error('设置文本失败');
                }

                // 等待一下确保文本已设置
                await new Promise(resolve => setTimeout(resolve, 100));

                // 3. 查找发送按钮
                const sendButton = this.findSendButton();
                if (!sendButton) {
                    throw new Error('未找到发送按钮');
                }

                // 4. 点击发送按钮
                const clicked = this.clickSendButton(sendButton);
                if (!clicked) {
                    throw new Error('点击发送按钮失败');
                }

                // 5. 等待新消息出现
                console.error('⏳ 等待新消息出现...');
                const newMessageIndex = await this.waitForNewMessage(initialMaxIndex, timeout);

                // 6. 🎯 使用按钮状态检测等待消息完成
                console.error('⏳ 等待按钮状态变化...');
                await this.waitForButtonComplete(timeout);

                // 额外等待内容稳定（缩短时间）
                // console.error('⏳ 等待内容稳定...');
                // await this.waitForContentStability(newMessageIndex, 10000); // 10秒足够

                // 7. 重新获取最新的最大消息索引
                const finalMaxIndex = this.getCurrentMaxMessageIndex();
                console.error(`📊 最终最大消息索引: ${finalMaxIndex}`);

                // 8. 收集所有相关消息内容
                const responseContents = [];

                // 从初始索引+2开始收集（跳过用户消息）
                for (let i = initialMaxIndex + 2; i <= finalMaxIndex; i++) {
                    try {
                        const content = this.extractMessageContent(i);
                        if (content && content.trim()) {
                            responseContents.push(content);
                            console.error(`✅ 收集消息 ${i}: ${content.substring(0, 50)}...`);
                        }
                    } catch (extractError) {
                        console.error(`❌ 提取消息 ${i} 失败:`, extractError);
                    }
                }

                if (responseContents.length === 0) {
                    throw new Error('未能提取任何响应内容');
                }

                // 组合所有内容
                const fullContent = responseContents.join('\n\n');
                console.error(`✅ 收集到 ${responseContents.length} 条消息内容`);

                // 9. 返回结果
                const result = {
                    success: true,
                    message: message,
                    response: fullContent,
                    timestamp: new Date().toISOString()
                };

                console.error('🎉 消息发送和接收成功！');
                return result;

            } catch (error) {
                console.error('❌ 发送消息失败:', error.message);
                throw error;
            }
        }
    };

    // ============== WebSocket客户端部分 ==============
    const WEBSOCKET_URL = 'ws://localhost:8766';

    class CursorClient {
        constructor() {
            this.ws = null;
            this.isConnected = false;
            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = 10;
            this.reconnectDelay = 1000;

            this.init();
        }

        init() {
            console.error('🔌 连接到MCP服务器...');
            this.connect();
        }

        connect() {
            console.error(`🔗 WebSocket: ${WEBSOCKET_URL}`);

            try {
                this.ws = new WebSocket(WEBSOCKET_URL);

                this.ws.onopen = () => {
                    console.error('✅ 已连接到MCP服务器');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                };

                this.ws.onmessage = (event) => {
                    try {
                        const message = JSON.parse(event.data);
                        this.handleServerMessage(message);
                    } catch (error) {
                        console.error('❌ 解析消息失败:', error);
                    }
                };

                this.ws.onclose = () => {
                    console.error('❌ 与MCP服务器断开连接');
                    this.isConnected = false;
                    this.reconnect();
                };

                this.ws.onerror = (error) => {
                    console.error('❌ WebSocket错误:', error);
                };

            } catch (error) {
                console.error('❌ 创建WebSocket失败:', error);
                this.reconnect();
            }
        }

        reconnect() {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.error('❌ 达到最大重连次数');
                return;
            }

            this.reconnectAttempts++;
            const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

            console.error(`🔄 ${delay}ms后重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            setTimeout(() => {
                this.connect();
            }, delay);
        }

        async handleServerMessage(message) {
            console.error('📥 收到服务器消息:', message.type);

            switch (message.type) {
                case 'welcome':
                    console.error('🎉 ' + message.message);
                    break;

                case 'sendAndWait':
                    await this.handleSendAndWait(message);
                    break;

                default:
                    console.warn('⚠️ 未知消息类型:', message.type);
            }
        }

        async handleSendAndWait(message) {
            console.error('🚀 执行sendAndWait');
            console.error('📝 内容:', message.content);

            try {
                const result = await window.cursorPreciseInjector.sendMessageAndWait(
                    message.content,
                    message.timeout || 30000
                );

                console.error('✅ 执行成功，准备返回结果');
                console.error('📤 结果预览:', result.response.substring(0, 100) + '...');

                // 发送成功结果
                this.sendResult(message.requestId, true, result.response);

            } catch (error) {
                console.error('❌ 执行失败:', error);

                // 发送错误结果
                this.sendResult(message.requestId, false, null, error.message);
            }
        }

        sendResult(requestId, success, result, error) {
            if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
                const response = {
                    type: 'result',
                    requestId: requestId,
                    success: success,
                    result: result,
                    error: error,
                    timestamp: new Date().toISOString()
                };

                this.ws.send(JSON.stringify(response));
                console.error('📤 结果已发送到MCP服务器');
            } else {
                console.error('❌ 无法发送结果：WebSocket未连接');
            }
        }
    }

    // ============== 初始化 ==============
    console.error('🎯 初始化完整客户端...');

    // 创建WebSocket客户端
    window.cursorClient = new CursorClient();

    // 全局测试方法
    window.testMessage = async function (message) {
        try {
            const result = await window.cursorPreciseInjector.sendMessageAndWait(message || "测试消息");
            console.error('✅ 测试成功');
            return result;
        } catch (error) {
            console.error('❌ 测试失败:', error);
            throw error;
        }
    };

    // 诊断工具
    window.diagnose = function () {
        console.error('🔍 诊断当前页面状态...');
        const maxIndex = window.cursorPreciseInjector.getCurrentMaxMessageIndex();
        console.error('最大消息索引:', maxIndex);

        const copyButtons = document.querySelectorAll('.codicon-copy-two');
        console.error('复制按钮数量:', copyButtons.length);

        const messages = document.querySelectorAll('[data-message-index]');
        console.error('消息数量:', messages.length);
    };

    // 清理函数
    window.cleanupCursorClient = function () {
        console.error('🧹 清理Cursor客户端...');
        if (window.cursorClient && window.cursorClient.ws) {
            window.cursorClient.ws.close();
            window.cursorClient = null;
        }
        window.cursorClientInitialized = false;
        console.error('✅ 清理完成');
    };

    console.error('🎉 Cursor完整客户端已就绪（最终版）！');
    console.error('💡 使用方法：');
    console.error('testMessage("你的消息") - 测试发送消息');
    console.error('diagnose() - 诊断响应元素');
    console.error('cleanupCursorClient() - 清理客户端连接');

})();