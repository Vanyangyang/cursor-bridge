// Cursor完整客户端 - 稳定性增强版
// 修复了clickSendButton返回值问题
// 增强了消息完成检测的稳定性：
// - 内容稳定性检查从3次增加到5次
// - 检查间隔从1.5秒增加到2.5秒
// - 超时时reject而不是resolve，避免提前返回
// - 稳定性检查超时从10秒增加到20秒

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

    console.error('🎯 Cursor完整客户端启动（修复版）...');

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

        checkCompleteFlag: function () {
            // 根据completeelems.html，完成标志是底部的复制按钮
            const selectors = [
                '.anysphere-icon-button .codicon-copy-two',
                '.codicon-copy-two',
                // 更具体的选择器，查找最新消息的复制按钮
                '[data-message-index]:last-child .codicon-copy-two',
                'div[id^="bubble-"]:last-child .codicon-copy-two'
            ];

            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    // 检查最后一个元素（最新的）
                    const flag = elements[elements.length - 1];
                    if (this.isCopyButtonTrulyVisible(flag)) {
                        console.error('✅ 找到完成标志:', selector);
                        return true;
                    }
                }
            }

            console.error('⏳ 未找到完成标志，继续等待...');
            return false;
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
                    // 清空元素内容（避免使用innerHTML）
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
                return true;  // 明确返回true

            } catch (error) {
                console.error('❌ 点击失败:', error.message);
                return false;
            }
        },

        waitForComplete: function (timeout = 240000) {
            console.error('⏳ 等待响应...');

            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                let checkCount = 0;

                const checkInterval = setInterval(() => {
                    checkCount++;
                    const elapsed = Date.now() - startTime;

                    if (elapsed >= timeout) {
                        clearInterval(checkInterval);
                        console.error(`❌ 等待超时 (检查了${checkCount}次)`);
                        reject(new Error('等待响应超时'));
                        return;
                    }

                    if (this.checkCompleteFlag()) {
                        clearInterval(checkInterval);
                        console.error(`🎉 响应完成！(第${checkCount}次检查)`);
                        resolve(true);
                    }

                    // 每5秒报告一次状态
                    if (checkCount % 10 === 0) {
                        console.error(`⏳ 仍在等待... (已等待${Math.floor(elapsed / 1000)}秒)`);
                    }
                }, 500);
            });
        },

        extractConversationContent: function (sentMessage) {
            console.error('📥 提取对话内容...');

            try {
                // 首先尝试查找最新的AI响应
                // 基于conversationelems.html的真实结构
                const responseSelectors = [
                    // 根据HTML文件的真实结构
                    '[data-message-index]:last-child .anysphere-markdown-container-root',
                    '[data-message-index]:last-child .markdown-section',

                    // 更具体的选择器
                    'div[id^="bubble-"]:last-child .anysphere-markdown-container-root',
                    'div[data-message-index]:last-child span[class*="markdown"]',

                    // 备用选择器
                    '.anysphere-markdown-container-root:last-of-type',
                    '.markdown-section:last-of-type',
                    '[data-markdown-raw]:last-of-type'
                ];

                for (const selector of responseSelectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        // 获取最后一个元素（最新的响应）
                        const lastElement = elements[elements.length - 1];

                        // 尝试多种方式获取内容
                        let content = '';

                        // 1. 检查data-markdown-raw属性
                        if (lastElement.hasAttribute('data-markdown-raw')) {
                            content = lastElement.getAttribute('data-markdown-raw');
                            console.error('✅ 从data-markdown-raw获取内容');
                        }

                        // 2. 如果没有，尝试获取所有markdown-section的内容
                        if (!content) {
                            const sections = lastElement.querySelectorAll('.markdown-section');
                            if (sections.length > 0) {
                                content = Array.from(sections)
                                    .map(s => s.getAttribute('data-markdown-raw') || s.textContent)
                                    .filter(t => t && t.trim())
                                    .join('\n');
                                console.error('✅ 从markdown-section获取内容');
                            }
                        }

                        // 3. 最后尝试普通文本内容
                        if (!content) {
                            content = lastElement.textContent || lastElement.innerText || '';
                        }

                        if (content && content.trim().length > 0) {
                            console.error(`✅ 使用选择器 "${selector}" 找到响应`);
                            return content.trim();
                        }
                    }
                }

                // 如果找不到，尝试更通用的方法
                console.error('⚠️ 使用备用方法提取内容');

                // 安全地获取页面文本
                let allText = '';
                try {
                    allText = document.body.innerText || document.body.textContent || '';
                } catch (e) {
                    console.error('❌ 无法获取body文本:', e.message);
                    // 尝试从根元素获取
                    try {
                        const root = document.documentElement || document.body;
                        allText = root.innerText || root.textContent || '';
                    } catch (e2) {
                        console.error('❌ 无法从根元素获取文本:', e2.message);
                    }
                }

                if (allText) {
                    const lines = allText.split('\n').filter(line => line.trim());

                    // 查找我们发送的消息之后的内容
                    const ourMessage = lines.findIndex(line => line.includes(sentMessage || '测试消息'));
                    if (ourMessage >= 0 && ourMessage < lines.length - 1) {
                        // 返回我们消息之后的内容
                        return lines.slice(ourMessage + 1).join('\n');
                    }
                }

                // 最后的备用方案：等待一下然后返回占位符
                console.error('⚠️ 使用占位符响应（实际响应可能需要手动查看）');
                return `[Cursor AI响应 - ${new Date().toLocaleTimeString()}] 响应内容需要手动查看控制台`;

            } catch (error) {
                console.error('❌ 提取失败:', error.message);
                return null;
            }
        },

        // 诊断函数：帮助找到正确的选择器
        diagnoseResponseElements: function () {
            console.error('🔍 诊断响应元素...');

            // 检查各种可能的容器（基于HTML文件）
            const possibleSelectors = [
                // 基于conversationelems.html的选择器
                '[data-message-index]',
                '.anysphere-markdown-container-root',
                '.markdown-section',
                'div[id^="bubble-"]',
                '[data-markdown-raw]',

                // 完成标志相关
                '.codicon-copy-two',
                '.anysphere-icon-button',

                // 其他可能的选择器
                '.prose', '.prose.break-words',
                '[class*="message"]', '[class*="markdown"]'
            ];

            possibleSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    console.error(`✅ 找到 ${elements.length} 个元素: ${selector}`);
                    // 显示最后一个元素的部分内容
                    const last = elements[elements.length - 1];
                    const text = (last.textContent || '').substring(0, 100);
                    console.error(`   内容预览: ${text}...`);
                }
            });

            // 检查消息后的DOM结构
            console.error('\n📋 页面中所有具有文本内容的元素:');
            const allElements = document.querySelectorAll('*');
            const textElements = Array.from(allElements).filter(el => {
                const text = el.textContent || '';
                return text.trim().length > 20 &&
                    text.trim().length < 1000 &&
                    el.children.length < 5;
            });

            textElements.slice(-10).forEach((el, i) => {
                console.error(`${i + 1}. ${el.tagName}.${el.className}: ${el.textContent.substring(0, 50)}...`);
            });
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

        // 检查复制按钮是否真正可见（简化版本）
        isCopyButtonTrulyVisible: function (copyButton) {
            if (!copyButton) {
                console.error('🔍 可见性检查: 复制按钮不存在');
                return false;
            }

            // 1. 基础可见性检查
            const rect = copyButton.getBoundingClientRect();
            const hasSize = rect.width > 0 && rect.height > 0;
            const isInDOM = copyButton.offsetParent !== null;

            console.error(`🔍 基础检查: 大小=${hasSize} (${rect.width}x${rect.height}) DOM=${isInDOM}`);

            if (!hasSize || !isInDOM) {
                return false;
            }

            // 2. 检查基本样式可见性（智能处理opacity）
            const style = window.getComputedStyle(copyButton);
            const opacity = parseFloat(style.opacity);
            const isStyleVisible = style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                opacity > 0.1; // 允许微小的透明度值

            console.error(`🔍 样式检查: display=${style.display} visibility=${style.visibility} opacity=${style.opacity}`);

            if (!isStyleVisible) {
                return false;
            }

            // 3. 检查直接父容器（只检查1层，避免过度检查，忽略opacity）
            const parent = copyButton.parentElement;
            if (parent && parent !== document.body) {
                const parentStyle = window.getComputedStyle(parent);
                const parentVisible = parentStyle.display !== 'none' &&
                    parentStyle.visibility !== 'hidden';

                console.error(`🔍 父容器检查: ${parentVisible} (opacity=${parentStyle.opacity})`);

                if (!parentVisible) {
                    return false;
                }
            }

            console.error('✅ 复制按钮可见性检查通过');
            return true;
        },

        // 等待新消息出现（等待AI回复，不是用户消息）
        waitForNewMessage: function (initialMaxIndex, timeout = 240000) {
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

        // 等待指定消息完成（只检查特定消息的复制按钮）
        waitForSpecificMessageComplete: function (targetMessageIndex, timeout = 240000) {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                let consecutiveSuccessCount = 0;
                const requiredSuccessCount = 2;

                console.error(`🎯 等待消息 ${targetMessageIndex} 完成...`);

                const checkInterval = setInterval(() => {
                    const elapsed = Date.now() - startTime;

                    // 首先检查超时（确保在所有情况下都会检查）
                    if (elapsed > timeout) {
                        clearInterval(checkInterval);
                        console.error(`❌ 等待消息 ${targetMessageIndex} 超时（已等待 ${Math.floor(elapsed / 1000)} 秒）`);
                        reject(new Error(`等待消息 ${targetMessageIndex} 完成超时`));
                        return;
                    }

                    // 只检查指定的消息
                    const targetMessage = document.querySelector(`[data-message-index="${targetMessageIndex}"]`);

                    if (!targetMessage) {
                        console.error(`❌ 目标消息 ${targetMessageIndex} 不存在`);
                        consecutiveSuccessCount = 0;
                        return;
                    }

                    // 1. 检查消息是否还在生成状态
                    const isGenerating = this.isMessageGenerating(targetMessage);
                    if (isGenerating) {
                        console.error(`⏳ 消息 ${targetMessageIndex} 还在生成中... (已等待 ${Math.floor(elapsed / 1000)} 秒)`);
                        consecutiveSuccessCount = 0;
                        return;
                    }

                    // 2. 查找这个特定消息的复制按钮
                    const copyButton = this.findCopyButtonForMessage(targetMessage);

                    if (copyButton && this.isCopyButtonTrulyVisible(copyButton)) {
                        consecutiveSuccessCount++;
                        console.error(`✅ 消息 ${targetMessageIndex} 复制按钮检查通过 ${consecutiveSuccessCount}/${requiredSuccessCount}`);

                        if (consecutiveSuccessCount >= requiredSuccessCount) {
                            console.error(`🎉 消息 ${targetMessageIndex} 完成检测成功！`);
                            console.error(`🎯 [复制按钮检测] 消息${targetMessageIndex}的复制按钮已稳定可见，开始准备内容提取`);
                            clearInterval(checkInterval);
                            resolve();
                            return;
                        }
                    } else {
                        consecutiveSuccessCount = 0;
                        console.error(`⏳ 消息 ${targetMessageIndex} 复制按钮未就绪，继续等待...`);
                    }
                }, 1000); // 减少检查间隔到1秒
            });
        },

        // 等待内容稳定性 - 确保消息内容不再变化
        waitForContentStability: function (targetMessageIndex, timeout = 10000) {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                let lastContentHash = null;
                let stableCount = 0;
                const requiredStableCount = 5; // 需要连续5次内容不变

                console.error(`🔄 开始检查消息 ${targetMessageIndex} 的内容稳定性...`);

                const checkInterval = setInterval(() => {
                    const targetMessage = document.querySelector(`[data-message-index="${targetMessageIndex}"]`);

                    if (!targetMessage) {
                        console.error(`❌ 目标消息 ${targetMessageIndex} 不存在`);
                        clearInterval(checkInterval);
                        reject(new Error(`消息 ${targetMessageIndex} 不存在`));
                        return;
                    }

                    // 获取消息的文本内容
                    const currentContent = targetMessage.textContent || '';
                    const currentContentHash = this.hashString(currentContent);

                    if (lastContentHash === null) {
                        // 首次检查
                        lastContentHash = currentContentHash;
                        console.error(`📝 首次内容检查，内容长度: ${currentContent.length}`);
                        return;
                    }

                    if (currentContentHash === lastContentHash) {
                        // 内容未变化
                        stableCount++;
                        console.error(`✅ 内容稳定检查 ${stableCount}/${requiredStableCount} (长度: ${currentContent.length})`);

                        if (stableCount >= requiredStableCount) {
                            console.error(`🎉 消息 ${targetMessageIndex} 内容已稳定！`);
                            clearInterval(checkInterval);
                            resolve();
                            return;
                        }
                    } else {
                        // 内容发生变化
                        const oldLength = lastContentHash ? 'unknown' : 0;
                        console.error(`🔄 内容仍在变化，长度从 ${oldLength} 变为 ${currentContent.length}，重置稳定计数`);
                        lastContentHash = currentContentHash;
                        stableCount = 0;
                    }

                    // 检查超时
                    if (Date.now() - startTime > timeout) {
                        clearInterval(checkInterval);
                        console.error(`⏰ 内容稳定性检查超时 (${timeout}ms)`);
                        reject(new Error(`内容稳定性检查超时`)); // 超时时明确失败
                        return;
                    }
                }, 2500); // 每2.5秒检查一次内容稳定性
            });
        },

        // 简单字符串哈希函数
        hashString: function (str) {
            let hash = 0;
            if (str.length === 0) return hash;
            for (let i = 0; i < str.length; i++) {
                const char = str.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // 转换为32位整数
            }
            return hash;
        },

        // 检查消息是否还在生成中
        isMessageGenerating: function (messageElement) {
            // 1. 检查是否是用户消息（用户消息不需要生成检查）
            const isUserMessage = messageElement.querySelector('.composer-human-message');
            if (isUserMessage) {
                console.error('👤 这是用户消息，跳过生成检查');
                return false;
            }

            // 2. 检查是否有"Generating..."文本
            const text = messageElement.textContent || '';
            if (text.includes('Generating') || text.includes('生成中')) {
                console.error('⏳ 发现Generating文本，消息还在生成');
                return true;
            }

            // 3. 检查是否有加载动画元素
            const loadingElements = messageElement.querySelectorAll('[class*="loading"], [class*="generating"], [class*="spinner"]');
            if (loadingElements.length > 0) {
                console.error('⏳ 发现加载元素，消息还在生成');
                return true;
            }

            // 4. 检查是否有实际内容
            const contentSelectors = [
                '.anysphere-markdown-container-root',
                '.markdown-section',
                '.composer-tool-former-message',
                '.message-content-animated'
            ];

            let hasContent = false;
            for (const selector of contentSelectors) {
                if (messageElement.querySelector(selector)) {
                    hasContent = true;
                    break;
                }
            }

            if (!hasContent) {
                console.error('⏳ 消息还没有内容，可能在生成中');
                return true;
            }

            // 5. 唯一标准：检查复制按钮是否存在
            const copyButton = this.findCopyButtonForMessage(messageElement);
            if (!copyButton) {
                console.error('⏳ 复制按钮未出现，消息还在生成');
                return true;
            }

            console.error('✅ 消息已完成生成（复制按钮存在）');
            return false;
        },

        // 为特定消息查找复制按钮
        findCopyButtonForMessage: function (messageElement) {
            console.error(`🔍 为特定消息查找复制按钮...`);

            // 步骤1：找到消息容器（有data-message-index属性的div）
            let messageContainer = messageElement;

            // 如果传入的不是消息容器，向上查找
            if (!messageContainer.hasAttribute('data-message-index')) {
                messageContainer = messageContainer.closest('[data-message-index]');
            }

            if (!messageContainer) {
                console.error(`❌ 找不到消息容器`);
                return null;
            }

            console.error(`✅ 找到消息容器: data-message-index="${messageContainer.getAttribute('data-message-index')}"`);

            // 步骤2：找到操作栏容器（父容器中倒数第二个子容器div）
            const parentContainer = messageContainer.parentElement;
            if (!parentContainer) {
                console.error(`❌ 找不到父容器`);
                return null;
            }

            // 获取所有子div
            const childDivs = Array.from(parentContainer.children).filter(child => child.tagName === 'DIV');

            // 操作栏是倒数第二个子div
            const actionBarContainer = childDivs[childDivs.length - 2];

            if (!actionBarContainer) {
                console.error(`❌ 找不到操作栏容器（倒数第二个子div）`);
                return null;
            }

            console.error(`✅ 找到操作栏容器（倒数第二个子div）`);

            // 步骤3：在操作栏容器中查找复制按钮
            const copyButtons = actionBarContainer.querySelectorAll('.codicon-copy-two');
            for (const button of copyButtons) {
                const buttonContainer = button.closest('div[class*="anysphere-icon-button"]');
                if (buttonContainer) {
                    // 检查按钮是否可见（没有opacity: 0）
                    const style = getComputedStyle(buttonContainer);
                    if (style.opacity !== '0') {
                        console.error(`✅ 找到可见的操作栏复制按钮`);
                        return button;
                    }
                }
            }

            console.error(`❌ 在操作栏中未找到复制按钮`);
            return null;
        },

        // 提取最新消息内容
        extractLatestMessageContent: function () {
            const latestMessageIndex = this.getCurrentMaxMessageIndex();
            const latestMessage = document.querySelector(`[data-message-index="${latestMessageIndex}"]`);

            if (!latestMessage) {
                console.error('❌ 未找到最新消息');
                return null;
            }

            console.error(`📥 提取消息 index: ${latestMessageIndex}`);

            // 1. 尝试从markdown-section提取
            const markdownSections = latestMessage.querySelectorAll('.markdown-section');
            if (markdownSections.length > 0) {
                const contents = [];
                markdownSections.forEach(section => {
                    const raw = section.getAttribute('data-markdown-raw');
                    if (raw && raw.trim()) {
                        // 解码HTML实体
                        const decodedContent = this.decodeHtmlEntities(raw.trim());
                        contents.push(decodedContent);
                    } else {
                        // 如果没有 raw 属性，使用 extractTextFromSection
                        const textContent = this.extractTextFromSection(section);
                        if (textContent && textContent.trim()) {
                            contents.push(textContent.trim());
                        }
                    }
                });

                if (contents.length > 0) {
                    const fullContent = contents.join('\n\n');
                    console.error('✅ 从markdown-section提取内容成功');
                    return fullContent;
                }
            }

            // 2. 备用：提取文本内容
            const markdownContainer = latestMessage.querySelector('.anysphere-markdown-container-root');
            if (markdownContainer) {
                const text = markdownContainer.textContent || '';
                if (text.trim()) {
                    console.error('✅ 从text内容提取成功');
                    return text.trim();
                }
            }

            console.error('⚠️ 无法提取消息内容');
            return null; // 返回 null 而不是错误消息
        },

        // 解码HTML实体
        decodeHtmlEntities: function (text) {
            // 避免使用innerHTML，手动解码常见的HTML实体
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

            // 处理数字实体 &#123; 等
            decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
                return String.fromCharCode(dec);
            });

            // 处理十六进制实体 &#x1F; 等
            decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
                return String.fromCharCode(parseInt(hex, 16));
            });

            return decoded;
        },

        // 从section中提取纯文本（智能处理代码块）
        extractTextFromSection: function (section) {
            // 如果section有data-markdown-raw属性，优先使用它
            const rawMarkdown = section.getAttribute('data-markdown-raw');
            if (rawMarkdown && rawMarkdown.trim()) {
                console.error('✅ 使用 data-markdown-raw 属性内容');
                return this.decodeHtmlEntities(rawMarkdown.trim());
            }

            // 检查是否只包含独立的代码编辑器（没有其他内容）
            const hasOnlyCodeEditor = section.querySelector('.composer-code-block-container') &&
                !section.querySelector('.markdown-section') &&
                !rawMarkdown;

            if (hasOnlyCodeEditor) {
                console.error('⏭️ 跳过独立的代码编辑器（无实质内容）');
                return null; // 返回null表示跳过
            }

            // 对于其他情况，提取纯文本内容（避免重复提取代码块）
            const clone = section.cloneNode(true);

            // 移除代码编辑器元素
            const excludeSelectors = [
                '.monaco-editor',
                '.composer-code-block-container',
                '.markdown-code-outer-container'
            ];

            excludeSelectors.forEach(selector => {
                const elements = clone.querySelectorAll(selector);
                elements.forEach(el => el.remove());
            });

            // 提取剩余的文本内容
            const remainingText = clone.textContent || '';

            return remainingText.trim() || null;
        },

        // 提取指定消息的内容
        extractMessageContent: function (messageIndex) {
            console.error(`📥 提取消息 ${messageIndex} 的内容...`);

            const message = document.querySelector(`[data-message-index="${messageIndex}"]`);
            if (!message) {
                console.error(`❌ 未找到消息 ${messageIndex}`);
                // 尝试查找最接近的消息
                const allMessages = document.querySelectorAll('[data-message-index]');
                if (allMessages.length > 0) {
                    const indices = Array.from(allMessages).map(m => parseInt(m.getAttribute('data-message-index')));
                    console.error(`📊 当前页面有消息索引: ${indices.join(', ')}`);
                }
                return null;
            }

            // 检查是否是用户消息（跳过）
            const isUserMessage = message.querySelector('.composer-human-message');
            if (isUserMessage) {
                console.error(`👤 消息 ${messageIndex} 是用户消息，跳过`);
                return null;
            }

            // 检查是否是工具调用消息
            const toolMessage = message.querySelector('.composer-tool-former-message');
            if (toolMessage) {
                console.error(`🔧 消息 ${messageIndex} 是工具调用信息`);

                // 检查是否是只有标题没有内容的工具调用（折叠状态）
                const hasCollapsibleContent = toolMessage.querySelector('.collapsible-content');
                const hasToolResult = toolMessage.querySelector('[class*="tool-result"], [class*="tool-output"], .composer-tool-result, .composer-tool-output');

                if (!hasCollapsibleContent && !hasToolResult) {
                    // 这是一个折叠的工具调用，只有标题，没有实际内容
                    const headerText = toolMessage.querySelector('.collapsible-header-text');
                    if (headerText) {
                        const toolName = headerText.textContent || '';
                        console.error(`   ⏭️ 跳过折叠的工具调用: ${toolName}`);
                        console.error(`   💡 实际结果可能在后续消息中`);
                        return null; // 返回null表示跳过这条消息
                    }
                }

                // 提取工具调用信息
                const toolContent = [];

                // 查找所有的工具调用文本
                const toolTexts = toolMessage.querySelectorAll('.collapsible-header-text');
                toolTexts.forEach(text => {
                    const content = text.textContent || '';
                    if (content.trim()) {
                        toolContent.push(`[Tool] ${content.trim()}`);
                    }
                });

                // 查找展开的工具内容（如果有） - 改进选择器
                const expandedSelectors = [
                    '.collapsible-content',
                    '.composer-tool-result',
                    '.composer-tool-output',
                    '[class*="tool-result"]',
                    '[class*="tool-output"]'
                ];

                let foundExpandedContent = false;
                for (const selector of expandedSelectors) {
                    const expandedElements = toolMessage.querySelectorAll(selector);
                    expandedElements.forEach(element => {
                        const expanded = element.textContent || '';
                        if (expanded.trim() && !toolContent.includes(expanded.trim())) {
                            toolContent.push(expanded.trim());
                            console.error(`   ✅ 从 ${selector} 提取到内容`);
                            foundExpandedContent = true;
                        }
                    });
                }

                // 如果没有找到展开内容，可能是折叠状态
                if (!foundExpandedContent && toolContent.length === 1) {
                    console.error(`   ⚠️ 工具调用可能处于折叠状态，只有标题`);
                    // 对于Searched等工具，实际内容可能在后续消息中
                    if (toolContent[0].includes('Searched')) {
                        console.error(`   🔍 Searched工具的结果应该在后续消息中`);
                        return null; // 跳过，让后续消息处理实际内容
                    }
                }

                if (toolContent.length > 0 && foundExpandedContent) {
                    const joinedContent = toolContent.join('\n');
                    console.error(`✅ 提取工具调用信息成功 (共 ${toolContent.length} 部分)`);
                    console.error(`🔧 [工具内容提取完成] 消息${messageIndex}: ${toolContent.length}部分, 总长度${joinedContent.length}, 前100字符: ${joinedContent.substring(0, 100)}...`);
                    return joinedContent;
                }

                // 如果只有标题没有内容，返回null跳过
                if (toolContent.length === 1 && !foundExpandedContent) {
                    console.error(`   ⏭️ 跳过只有标题的工具调用`);
                    return null;
                }

                // 如果提取失败，返回整个工具消息的文本
                const fallbackText = toolMessage.textContent || '';
                if (fallbackText.trim()) {
                    return `[Tool Message] ${fallbackText.trim()}`;
                }
            }

            // 1. 尝试从markdown-section提取
            const markdownSections = message.querySelectorAll('.markdown-section');
            if (markdownSections.length > 0) {
                console.error(`📋 发现 ${markdownSections.length} 个 markdown-section`);
                const contents = [];
                markdownSections.forEach((section, idx) => {
                    // 优先使用 data-markdown-raw 属性
                    const raw = section.getAttribute('data-markdown-raw');
                    if (raw && raw.trim()) {
                        console.error(`✅ Section ${idx}: 发现 data-markdown-raw 属性`);
                        try {
                            // 解码HTML实体
                            const decodedContent = this.decodeHtmlEntities(raw.trim());
                            contents.push(decodedContent);
                            console.error(`   解码成功，长度: ${decodedContent.length}`);
                        } catch (decodeError) {
                            console.error(`   ❌ 解码失败:`, decodeError);
                            // 失败时使用原始内容
                            contents.push(raw.trim());
                        }
                    } else {
                        console.error(`⚠️ Section ${idx}: 没有 data-markdown-raw，尝试提取文本`);
                        // 如果没有 raw 属性，尝试提取文本内容（避免代码编辑器）
                        const textContent = this.extractTextFromSection(section);
                        if (textContent && textContent.trim()) {
                            contents.push(textContent.trim());
                        }
                    }
                });

                if (contents.length > 0) {
                    const fullContent = contents.join('\n\n');
                    console.error(`✅ 从消息 ${messageIndex} 的markdown-section提取内容成功，总长度: ${fullContent.length}`);
                    console.error(`📄 [内容提取完成] 消息${messageIndex}: ${contents.length}个section, 前100字符: ${fullContent.substring(0, 100)}...`);
                    return fullContent;
                } else {
                    console.error(`❌ 从消息 ${messageIndex} 的markdown-section提取失败：没有有效内容`);
                }
            }

            // 2. 备用：提取文本内容
            const markdownContainer = message.querySelector('.anysphere-markdown-container-root');
            if (markdownContainer) {
                const text = markdownContainer.textContent || '';
                if (text.trim()) {
                    console.error(`✅ 从消息 ${messageIndex} 的text内容提取成功`);
                    console.error(`📄 [备用内容提取完成] 消息${messageIndex}: textContent长度${text.length}, 前100字符: ${text.substring(0, 100)}...`);
                    return text.trim();
                }
            }

            console.error(`⚠️ 无法提取消息 ${messageIndex} 的内容`);
            return null; // 返回 null 而不是错误消息
        },

        sendMessageAndWait: async function (message, timeout = 240000) {
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
                console.error('点击结果:', clicked);

                if (!clicked) {
                    throw new Error('点击发送按钮失败');
                }

                // 5. 等待新消息出现
                console.error('⏳ 等待新消息出现...');
                const newMessageIndex = await this.waitForNewMessage(initialMaxIndex, timeout);

                // 6. 等待这个特定的新消息完成
                console.error(`⏳ 等待消息 ${newMessageIndex} 完成...`);
                await this.waitForSpecificMessageComplete(newMessageIndex, timeout);

                // 额外等待确保所有消息DOM都已完全渲染，并检查内容稳定性
                console.error('⏳ 等待DOM完全渲染并检查内容稳定性...');
                await this.waitForContentStability(newMessageIndex, 20000); // 等待内容稳定

                // 7. 重新获取最新的最大消息索引（因为可能有后续消息）
                const finalMaxIndex = this.getCurrentMaxMessageIndex();
                console.error(`📊 最终最大消息索引: ${finalMaxIndex} (之前是 ${newMessageIndex})`);

                // 8. 收集所有相关消息内容（工具调用 + 文本响应）
                const responseContents = [];

                // 从初始索引+2开始收集（跳过用户消息，直接从AI回复开始）
                // initialMaxIndex + 1 是用户消息
                // initialMaxIndex + 2 开始是AI的回复
                // 一直收集到最后一个消息（finalMaxIndex）
                for (let i = initialMaxIndex + 2; i <= finalMaxIndex; i++) {
                    console.error(`🔍 尝试提取消息 ${i}...`);
                    const messageElement = document.querySelector(`[data-message-index="${i}"]`);

                    if (messageElement) {
                        // 诊断消息类型
                        const isUser = messageElement.querySelector('.composer-human-message');
                        const isTool = messageElement.querySelector('.composer-tool-former-message');
                        const hasMarkdown = messageElement.querySelector('.markdown-section');

                        console.error(`   类型: ${isUser ? '用户消息' : isTool ? '工具调用' : hasMarkdown ? 'AI响应' : '未知'}`);

                        // 双重检查：如果是用户消息，跳过
                        if (isUser) {
                            console.error(`   ⏭️ 跳过用户消息`);
                            continue;
                        }
                    }

                    try {
                        const content = this.extractMessageContent(i);
                        if (content && content.trim() && !content.startsWith('[消息内容提取失败')) {
                            responseContents.push(content);
                            console.error(`   ✅ 成功收集: ${content.substring(0, 50)}...`);
                            console.error(`📊 [内容收集] 消息${i}: 长度${content.length}, 当前总共收集${responseContents.length}条消息`);
                        } else if (content && content.startsWith('[消息内容提取失败')) {
                            console.error(`   ❌ 提取失败，跳过`);
                        } else if (!content) {
                            console.error(`   ⏭️ 空内容，跳过`);
                        }
                    } catch (extractError) {
                        console.error(`   ❌ 提取消息 ${i} 时发生异常:`, extractError);
                    }
                }

                if (responseContents.length === 0) {
                    // 添加详细的调试信息
                    console.error('❌ 未能提取任何响应内容！');
                    console.error(`尝试的消息范围: ${initialMaxIndex + 2} 到 ${finalMaxIndex}`);

                    // 尝试获取失败原因
                    for (let i = initialMaxIndex + 2; i <= finalMaxIndex; i++) {
                        const msg = document.querySelector(`[data-message-index="${i}"]`);
                        if (msg) {
                            const hasSections = msg.querySelectorAll('.markdown-section').length;
                            const hasContainer = msg.querySelector('.anysphere-markdown-container-root');
                            console.error(`消息 ${i}: sections=${hasSections}, container=${!!hasContainer}`);
                        } else {
                            console.error(`消息 ${i}: 不存在`);
                        }
                    }

                    throw new Error('未能提取任何响应内容');
                }

                // 组合所有内容
                const fullContent = responseContents.join('\n\n');
                console.error(`✅ 收集到 ${responseContents.length} 条消息内容`);
                console.error(`📊 消息范围: ${initialMaxIndex + 2} 到 ${finalMaxIndex}`);

                // 详细的最终提取总结
                console.error(`🎯 [最终内容提取总结]:`);
                console.error(`   - 初始消息索引: ${initialMaxIndex}`);
                console.error(`   - 最终消息索引: ${finalMaxIndex}`);
                console.error(`   - 提取范围: 消息${initialMaxIndex + 2}到${finalMaxIndex} (跳过用户消息${initialMaxIndex + 1})`);
                console.error(`   - 成功提取消息数: ${responseContents.length}条`);
                console.error(`   - 总内容长度: ${fullContent.length}字符`);
                console.error(`   - 内容开头: ${fullContent.substring(0, 150)}...`);
                console.error(`   - 内容结尾: ...${fullContent.substring(Math.max(0, fullContent.length - 150))}`);

                // 9. 返回结果
                const result = {
                    success: true,
                    message: message,
                    response: fullContent,
                    timestamp: new Date().toISOString()
                };

                console.error('🎉 [内容提取完成] 返回最终结果');
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
        window.cursorPreciseInjector.diagnoseResponseElements();
    };

    // 检查当前完成状态
    window.checkCompleteStatus = function () {
        const injector = window.cursorPreciseInjector;
        console.error('=== 当前完成状态检查 ===');

        // 1. 检查最大消息索引
        const maxIndex = injector.getCurrentMaxMessageIndex();
        console.error('最大消息索引:', maxIndex);

        // 2. 检查最新消息
        const latestMessage = document.querySelector(`[data-message-index="${maxIndex}"]`);
        if (latestMessage) {
            console.error('✅ 找到最新消息');

            // 3. 检查复制按钮
            const copyButton = latestMessage.querySelector('.codicon-copy-two');
            console.error('复制按钮存在:', !!copyButton);

            if (copyButton) {
                const isVisible = injector.isCopyButtonTrulyVisible(copyButton);
                console.error('复制按钮可见:', isVisible);
            }

            // 4. 检查内容
            const markdownContainer = latestMessage.querySelector('.anysphere-markdown-container-root');
            if (markdownContainer) {
                const contentLength = markdownContainer.textContent.length;
                console.error('内容长度:', contentLength);
                console.error('内容预览:', markdownContainer.textContent.substring(0, 100) + '...');
            }

            // 5. 检查markdown sections
            const sections = latestMessage.querySelectorAll('.markdown-section');
            console.error('Markdown sections:', sections.length);

        } else {
            console.error('❌ 未找到最新消息');
        }

        console.error('=== 检查完成 ===');
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

    // 调试函数：检查最近的消息提取情况
    window.debugLastConversation = function () {
        const injector = window.cursorPreciseInjector;
        console.error('=== 调试最近对话 ===');

        // 获取所有消息
        const allMessages = document.querySelectorAll('[data-message-index]');
        const messageInfos = [];

        allMessages.forEach(msg => {
            const index = msg.getAttribute('data-message-index');
            const isUser = msg.querySelector('.composer-human-message');
            const isTool = msg.querySelector('.composer-tool-former-message');
            const hasMarkdown = msg.querySelector('.markdown-section');
            const hasCopyButton = msg.querySelector('.codicon-copy-two');

            let type = '未知';
            if (isUser) type = '用户消息';
            else if (isTool) {
                const collapsed = !msg.querySelector('.collapsible-content');
                type = collapsed ? '工具调用(折叠)' : '工具调用(展开)';
            }
            else if (hasMarkdown) type = 'AI响应';

            messageInfos.push({
                index: parseInt(index),
                type: type,
                hasCopyButton: !!hasCopyButton,
                textPreview: (msg.textContent || '').substring(0, 100).replace(/\n/g, ' ')
            });
        });

        // 按索引排序
        messageInfos.sort((a, b) => a.index - b.index);

        // 显示消息列表
        console.error('\n📋 消息列表:');
        messageInfos.forEach(info => {
            const copyIcon = info.hasCopyButton ? '📋' : '  ';
            console.error(`${copyIcon} [${info.index}] ${info.type}: ${info.textPreview}...`);
        });

        // 找出最后一组对话
        if (messageInfos.length > 0) {
            const lastIndex = messageInfos[messageInfos.length - 1].index;
            let startIndex = lastIndex;

            // 向前查找用户消息
            for (let i = messageInfos.length - 1; i >= 0; i--) {
                if (messageInfos[i].type === '用户消息') {
                    startIndex = messageInfos[i].index;
                    break;
                }
            }

            console.error(`\n🎯 最后一组对话: ${startIndex} 到 ${lastIndex}`);

            // 提取这组对话的内容
            const contents = [];
            for (let i = startIndex + 1; i <= lastIndex; i++) {
                try {
                    const content = injector.extractMessageContent(i);
                    if (content && content.trim()) {
                        contents.push(`[消息 ${i}] ${content.substring(0, 200)}...`);
                    }
                } catch (e) {
                    console.error(`❌ 提取消息 ${i} 失败:`, e.message);
                }
            }

            console.error('\n📝 提取的内容:');
            contents.forEach(c => console.error(c));
        }

        console.error('\n=== 调试完成 ===');
    };

    console.error('🎉 Cursor完整客户端已就绪（修复版）！');
    console.error('💡 使用方法：');
    console.error('testMessage("你的消息") - 测试发送消息');
    console.error('diagnose() - 诊断响应元素');
    console.error('debugLastConversation() - 调试最近的对话');
    console.error('cleanupCursorClient() - 清理客户端连接');

})();