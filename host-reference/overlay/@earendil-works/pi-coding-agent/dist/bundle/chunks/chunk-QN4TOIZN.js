import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);
import{shortHash}from"./chunk-PJACZCIR.js";import{appendGrammarToolInputJsonDelta,closeGrammarToolInputJson,getGrammarToolInput,getJsonSchemaToolParameters,resolveGrammarConstrainedSampling,resolveJsonSchemaStrictSampling,transformMessages}from"./chunk-ZGYS4UTC.js";import{sanitizeSurrogates}from"./chunk-L2ZPNLYD.js";import{ToolCallArgumentsStream}from"./chunk-FFMDRXC4.js";import{calculateCost,resolveTranscript,resolveTranscriptTools}from"./chunk-AUUCDC7R.js";import{getSystemMessageText,renderSystemMessageUpdate}from"./chunk-BAC3QPNW.js";function encodeTextSignatureV1(id,phase){let payload={v:1,id};return phase&&(payload.phase=phase),JSON.stringify(payload)}function parseTextSignature(signature){if(signature){if(signature.startsWith("{"))try{let parsed=JSON.parse(signature);if(parsed.v===1&&typeof parsed.id=="string")return parsed.phase==="commentary"||parsed.phase==="final_answer"?{id:parsed.id,phase:parsed.phase}:{id:parsed.id}}catch{}return{id:signature}}}function convertToolResultOutput(model,content){let textResult=content.filter(c=>c.type==="text").map(c=>c.text).join(`
`),images=content.filter(c=>c.type==="image"),hasText=textResult.trim().length>0;if(images.length===0||!model.input.includes("image"))return sanitizeSurrogates(hasText?textResult:images.length>0?"(see attached image)":"(no tool output)");let output=[];hasText&&output.push({type:"input_text",text:sanitizeSurrogates(textResult)});for(let image of images)output.push({type:"input_image",detail:"auto",image_url:`data:${image.mimeType};base64,${image.data}`});return output}function getResponsesToolSupport(options){return options.supportsMidConvoSystemMessages&&options.supportsAdditionalTools?"changes":options.supportsToolSearch?"additions":"none"}function renderIncrementalToolsNotice(unavailable){let notice="This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.";return unavailable.size>0?`${notice}
Still unavailable: ${[...unavailable].join(", ")}.`:notice}function renderToolRemovalNotice(names){return`The following tools are no longer available. Do not call them:
${names.map(name=>`- ${name}`).join(`
`)}`}function convertResponsesMessages(model, context, allowedToolCallProviders, options) {
    const normalizedContext = resolveTranscript(context, options?.supportsMidConvoSystemMessages);
    const messages = [];
    const replay = options?.reasoningReplay;
    let replayEffort = replay?.initialEffort;
    let assistantIndex = 0;
    const appendReasoningUpdate = effort => {
        if (effort === undefined || effort === replayEffort) return;
        const update = { type: "configuration_update", reasoning: { effort } };
        // Empty successful outputs can leave two changes at the same wire position.
        // No input consumed the earlier change: keep only the final one (API forbids adjacency).
        if (messages.at(-1)?.type === "configuration_update") messages[messages.length - 1] = update;
        else messages.push(update);
        replayEffort = effort;
    };
    const normalizeIdPart = (part) => {
        const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
        const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
        return normalized.replace(/_+$/, "");
    };
    const buildForeignResponsesItemId = (itemId) => {
        const normalized = `fc_${shortHash(itemId)}`;
        return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
    };
    const normalizeToolCallId = (id, _targetModel, source) => {
        if (!allowedToolCallProviders.has(model.provider))
            return normalizeIdPart(id);
        if (!id.includes("|"))
            return normalizeIdPart(id);
        const [callId, itemId] = id.split("|");
        const normalizedCallId = normalizeIdPart(callId);
        const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
        let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
        // OpenAI Responses API requires item id to start with "fc"
        if (!normalizedItemId.startsWith("fc_")) {
            normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
        }
        return `${normalizedCallId}|${normalizedItemId}`;
    };
    const transformedMessages = transformMessages(normalizedContext.messages, model, normalizeToolCallId);
    const toolSupport = getResponsesToolSupport(options ?? {});
    const transcriptTools = resolveTranscriptTools(normalizedContext.messages, toolSupport);
    let declaredAdditionalTools = false;
    /** Tools announced as removed and not declared again since. */
    const unavailableTools = new Set();
    const appendSystemToolAdditions = (message, seed) => {
        const tools = message.toolsAdded ?? [];
        for (const tool of tools)
            unavailableTools.delete(tool.name);
        if (tools.length === 0)
            return;
        if (toolSupport === "changes") {
            if (declaredAdditionalTools) {
                messages.push({ role: instructionRole, content: renderIncrementalToolsNotice(unavailableTools) });
            }
            declaredAdditionalTools = true;
            messages.push({
                type: "additional_tools",
                role: "developer",
                tools: convertResponsesTools(tools, options?.toolOptions),
            });
            return;
        }
        if (toolSupport !== "additions")
            return;
        const names = tools.map((tool) => tool.name);
        const callId = `pi_tool_load_${shortHash(`${seed}:${names.join(",")}`)}`;
        messages.push({
            type: "tool_search_call",
            call_id: callId,
            execution: "client",
            status: "completed",
            arguments: { query: names.join(" "), limit: names.length },
        });
        messages.push({
            type: "tool_search_output",
            call_id: callId,
            execution: "client",
            status: "completed",
            tools: convertResponsesTools(tools, { ...options?.toolOptions, toolSearchResult: true }),
        });
    };
    const includeInitialSystemMessage = options?.includeSystemPrompt ?? true;
    const pushConfigurationUpdate = (effort) => {
        messages.push({
            type: "configuration_update",
            reasoning: { effort: effort },
        });
    };
    const compat = model.compat;
    const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
    let msgIndex = 0;
    let sourceIndex = 0;
    let systemIndex = 0;
    for (const msg of transformedMessages) {
        const isLeadingSystemMessage = sourceIndex++ === 0 && msg.role === "system";
        if (msg.role === "system") {
            // transformMessages keeps system messages in order, so their position matches the transcript.
            const anchorsToolChanges = systemIndex++ >= transcriptTools.foldedSystemMessages;
            if (anchorsToolChanges)
                appendSystemToolAdditions(msg, `system:${msgIndex}`);
            if (!isLeadingSystemMessage || includeInitialSystemMessage) {
                const parts = [isLeadingSystemMessage ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg)];
                if (anchorsToolChanges) {
                    // A redefinition is a removal plus an addition of the same name; only true removals are announced.
                    const added = new Set((msg.toolsAdded ?? []).map((tool) => tool.name));
                    const removed = (msg.toolsRemoved ?? []).map((tool) => tool.name).filter((name) => !added.has(name));
                    if (removed.length > 0)
                        parts.push(renderToolRemovalNotice(removed));
                    // Recorded after this message's additions, whose notice precedes this removal notice.
                    for (const name of removed)
                        unavailableTools.add(name);
                }
                const text = parts.filter((part) => part.length > 0).join("\n\n");
                if (text.length > 0) {
                    messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
                }
            }
        }
        else if (msg.role === "user") {
            if (typeof msg.content === "string") {
                messages.push({
                    role: "user",
                    content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
                });
            }
            else {
                const content = msg.content.map((item) => {
                    if (item.type === "text") {
                        return {
                            type: "input_text",
                            text: sanitizeSurrogates(item.text),
                        };
                    }
                    return {
                        type: "input_image",
                        detail: "auto",
                        image_url: `data:${item.mimeType};base64,${item.data}`,
                    };
                });
                if (content.length === 0)
                    continue;
                messages.push({
                    role: "user",
                    content,
                });
            }
        }
        else if (msg.role === "assistant") {
            const assistantEffort = replay?.assistantEfforts[assistantIndex++];
            const output = [];
            const assistantMsg = msg;
            const isSameProviderAndApi = assistantMsg.provider === model.provider && assistantMsg.api === model.api;
            const isSameModel = isSameProviderAndApi && assistantMsg.model === model.id;
            const isDifferentModel = isSameProviderAndApi && assistantMsg.model !== model.id;
            let textBlockIndex = 0;
            for (const block of msg.content) {
                if (block.type === "thinking") {
                    if (block.thinkingSignature) {
                        const reasoningItem = JSON.parse(block.thinkingSignature);
                        output.push(reasoningItem);
                    }
                }
                else if (block.type === "text") {
                    const textBlock = block;
                    const parsedSignature = parseTextSignature(textBlock.textSignature);
                    const fallbackMessageId = textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
                    textBlockIndex++;
                    // OpenAI requires id to be max 64 characters
                    let msgId = parsedSignature?.id;
                    if (!msgId) {
                        msgId = fallbackMessageId;
                    }
                    else if (msgId.length > 64) {
                        msgId = `msg_${shortHash(msgId)}`;
                    }
                    output.push({
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
                        status: "completed",
                        id: msgId,
                        phase: parsedSignature?.phase,
                    });
                }
                else if (block.type === "toolCall") {
                    const toolCall = block;
                    const [callId, itemIdRaw] = toolCall.id.split("|");
                    const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
                    let itemId = itemIdRaw;
                    // For different-model messages, set id to undefined to avoid pairing validation.
                    // OpenAI tracks which item IDs were paired with rs_xxx reasoning items.
                    // By omitting the id, we avoid triggering that validation (like cross-provider does).
                    // Also drop ids that do not match the replayed item type: function_call ids must be fc_*
                    // and custom_tool_call ids must be ctc_*. Foreign tool call ids are normalized to fc_*, and
                    // a call can switch between the two types when grammar tool support differs.
                    const itemIdPrefix = customInputProperty === undefined ? "fc_" : "ctc_";
                    if (isDifferentModel || !itemId?.startsWith(itemIdPrefix)) {
                        itemId = undefined;
                    }
                    if (customInputProperty !== undefined) {
                        output.push({
                            type: "custom_tool_call",
                            id: itemId,
                            call_id: callId,
                            name: toolCall.name,
                            input: sanitizeSurrogates(getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty)),
                            ...(isSameModel && toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
                        });
                    }
                    else {
                        output.push({
                            type: "function_call",
                            id: itemId,
                            call_id: callId,
                            name: toolCall.name,
                            arguments: JSON.stringify(toolCall.arguments),
                            ...(isSameModel && toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
                        });
                    }
                }
            }
            // A previous request's tail update precedes the output it generated.
            // Keep it here, not next to the following user/tool/system message.
            appendReasoningUpdate(assistantEffort);
            if (output.length === 0)
                continue;
            if (options?.configurationUpdateEffort !== undefined &&
                isSameModel &&
                msg.providerThinkingLevel !== undefined) {
                pushConfigurationUpdate(msg.providerThinkingLevel);
            }
            messages.push(...output);
        }
        else if (msg.role === "toolResult") {
            const [callId] = msg.toolCallId.split("|");
            const output = convertToolResultOutput(model, msg.content);
            if (options?.grammarToolInputProperties?.has(msg.toolName)) {
                messages.push({
                    type: "custom_tool_call_output",
                    call_id: callId,
                    output,
                });
            }
            else {
                messages.push({
                    type: "function_call_output",
                    call_id: callId,
                    output,
                });
            }
        }
        if (!isLeadingSystemMessage)
            msgIndex++;
    }
    if (options?.configurationUpdateEffort !== undefined)
        pushConfigurationUpdate(options.configurationUpdateEffort);
    appendReasoningUpdate(replay?.currentEffort);
    return messages;
}
// =============================================================================
// Tool conversion
// =============================================================================
function convertResponsesTools(tools,options){let defaultStrict=options?.strict===void 0?!1:options.strict,supportsStrictMode=options?.supportsStrictMode??!0,supportsOpenAIGrammarTools=options?.supportsOpenAIGrammarTools??!1;return tools.map(tool=>{let grammar=resolveGrammarConstrainedSampling(tool,supportsOpenAIGrammarTools);if(grammar)return{type:"custom",name:tool.name,description:tool.description,format:{type:"grammar",syntax:grammar.format,definition:grammar.definition},...options?.toolSearchResult?{defer_loading:!0}:{}};let strict=resolveJsonSchemaStrictSampling(tool,supportsStrictMode)??defaultStrict,functionTool={type:"function",name:tool.name,description:tool.description,parameters:getJsonSchemaToolParameters(tool,strict===!0),...options?.toolSearchResult?{defer_loading:!0}:{}};return supportsStrictMode&&(functionTool.strict=strict),functionTool})}async function processResponsesStream(openaiStream,output,stream,model,options){let sawTerminalResponseEvent=!1,outputSlots=new Map,unfinishedToolCalls=new Set,reasoningBlocksById=new Map,applyMessagePhaseStopReason=item=>{item.type==="message"&&item.phase==="final_answer"&&(output.stopReason="stop")},getSlot=(outputIndex,type)=>{let slot=outputSlots.get(outputIndex);return slot?.type===type?slot:void 0},pushToolCallDelta=(slot,delta)=>{delta!==void 0&&stream.push({type:"toolcall_delta",contentIndex:slot.contentIndex,delta,partial:output})},createSlot=(outputIndex,item)=>{if(item.type==="reasoning"){let block={type:"thinking",thinking:""};output.content.push(block);let slot={type:"thinking",block,contentIndex:output.content.length-1};return outputSlots.set(outputIndex,slot),stream.push({type:"thinking_start",contentIndex:slot.contentIndex,partial:output}),slot}if(item.type==="message"){applyMessagePhaseStopReason(item);let block={type:"text",text:""};output.content.push(block);let slot={type:"text",block,contentIndex:output.content.length-1};return outputSlots.set(outputIndex,slot),stream.push({type:"text_start",contentIndex:slot.contentIndex,partial:output}),slot}if(item.type==="function_call"){let args=new ToolCallArgumentsStream,block={type:"toolCall",id:`${item.call_id}|${item.id}`,name:item.name,arguments:item.arguments?args.append(item.arguments):{},...item.namespace!==void 0?{namespace:item.namespace}:{}};output.content.push(block),unfinishedToolCalls.add(block);let slot={type:"toolCall",block,contentIndex:output.content.length-1,input:{kind:"json",arguments:args}};return outputSlots.set(outputIndex,slot),stream.push({type:"toolcall_start",contentIndex:slot.contentIndex,partial:output}),slot}if(item.type==="custom_tool_call"){let inputProperty=options?.grammarToolInputProperties?.get(item.name)??"input",input=item.input||"",block={type:"toolCall",id:`${item.call_id}|${item.id}`,name:item.name,arguments:{[inputProperty]:input},...item.namespace!==void 0?{namespace:item.namespace}:{}};output.content.push(block),unfinishedToolCalls.add(block);let slot={type:"toolCall",block,contentIndex:output.content.length-1,input:customInput(inputProperty,input)};return outputSlots.set(outputIndex,slot),stream.push({type:"toolcall_start",contentIndex:slot.contentIndex,partial:output}),slot}},getOrCreateSlot=(outputIndex,item)=>outputSlots.get(outputIndex)??createSlot(outputIndex,item),backfillReasoningSignatures=responseOutput=>{for(let item of responseOutput){if(item.type!=="reasoning"||!item.encrypted_content)continue;let block=reasoningBlocksById.get(item.id);if(!block?.thinkingSignature)continue;let storedItem=JSON.parse(block.thinkingSignature);storedItem.encrypted_content||(block.thinkingSignature=JSON.stringify({...storedItem,encrypted_content:item.encrypted_content}))}},finalizeResponse=response=>{if(sawTerminalResponseEvent=!0,backfillReasoningSignatures(response.output??[]),response?.id&&(output.responseId=response.id),response?.usage){let inputDetails=response.usage.input_tokens_details,cachedTokens=inputDetails?.cached_tokens||0,cacheWriteTokens=inputDetails?.cache_write_tokens||0;output.usage={input:Math.max(0,(response.usage.input_tokens||0)-cachedTokens-cacheWriteTokens),output:response.usage.output_tokens||0,cacheRead:cachedTokens,cacheWrite:cacheWriteTokens,reasoning:response.usage.output_tokens_details?.reasoning_tokens||0,totalTokens:response.usage.total_tokens||0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}if(calculateCost(model,output.usage),options?.applyServiceTierPricing){let serviceTier=options.resolveServiceTier?options.resolveServiceTier(response?.service_tier,options.serviceTier):response?.service_tier??options.serviceTier;options.applyServiceTierPricing(output.usage,serviceTier)}let status=response?.status,incompleteDetails=response?.incomplete_details,incompleteReason=typeof incompleteDetails?.reason=="string"?incompleteDetails.reason:void 0;output.rawStopReason=incompleteReason?`${status}.${incompleteReason}`:status;let mappedStop=mapStopReason(status,incompleteReason);output.stopReason=mappedStop.stopReason,mappedStop.errorMessage===void 0?delete output.errorMessage:output.errorMessage=mappedStop.errorMessage,output.content.some(b=>b.type==="toolCall")&&output.stopReason==="stop"&&(output.stopReason="toolUse")};for await(let event of openaiStream)if(await options?.onProviderStreamEvent?.(event,model),event.type==="response.created")output.responseId=event.response.id;else if(event.type==="response.output_item.added")createSlot(event.output_index,event.item);else if(event.type==="response.reasoning_summary_text.delta"){let slot=getSlot(event.output_index,"thinking");if(!slot)continue;slot.block.thinking+=event.delta,stream.push({type:"thinking_delta",contentIndex:slot.contentIndex,delta:event.delta,partial:output})}else if(event.type==="response.reasoning_summary_part.done"){let slot=getSlot(event.output_index,"thinking");if(!slot)continue;slot.block.thinking+=`

`,stream.push({type:"thinking_delta",contentIndex:slot.contentIndex,delta:`

`,partial:output})}else if(event.type==="response.reasoning_text.delta"){let slot=getSlot(event.output_index,"thinking");if(!slot)continue;slot.block.thinking+=event.delta,stream.push({type:"thinking_delta",contentIndex:slot.contentIndex,delta:event.delta,partial:output})}else if(event.type==="response.output_text.delta"){let slot=getSlot(event.output_index,"text");if(!slot)continue;slot.block.text+=event.delta,stream.push({type:"text_delta",contentIndex:slot.contentIndex,delta:event.delta,partial:output})}else if(event.type==="response.refusal.delta"){let slot=getSlot(event.output_index,"text");if(!slot)continue;slot.block.text+=event.delta,stream.push({type:"text_delta",contentIndex:slot.contentIndex,delta:event.delta,partial:output})}else if(event.type==="response.function_call_arguments.delta"){let slot=getSlot(event.output_index,"toolCall");if(slot?.input.kind!=="json")continue;slot.block.arguments=slot.input.arguments.append(event.delta),pushToolCallDelta(slot,event.delta)}else if(event.type==="response.function_call_arguments.done"){let slot=getSlot(event.output_index,"toolCall");if(slot?.input.kind!=="json")continue;let replaced=slot.input.arguments.replace(event.arguments);slot.block.arguments=replaced.arguments,replaced.delta&&pushToolCallDelta(slot,replaced.delta)}else if(event.type==="response.custom_tool_call_input.delta"){let slot=getSlot(event.output_index,"toolCall");if(slot?.input.kind!=="custom")continue;pushToolCallDelta(slot,appendCustomInput(slot.block,slot.input,event.delta))}else if(event.type==="response.custom_tool_call_input.done"){let slot=getSlot(event.output_index,"toolCall");if(slot?.input.kind!=="custom")continue;pushToolCallDelta(slot,closeCustomInput(slot.block,slot.input,event.input))}else if(event.type==="response.output_item.done"){let item=event.item;applyMessagePhaseStopReason(item);let slot=getOrCreateSlot(event.output_index,item);if(item.type==="reasoning"&&slot?.type==="thinking"){let summaryText=item.summary?.map(s=>s.text).join(`

`)||"",contentText=item.content?.map(c=>c.text).join(`

`)||"";slot.block.thinking=summaryText||contentText||slot.block.thinking,slot.block.thinkingSignature=JSON.stringify(item),reasoningBlocksById.set(item.id,slot.block),stream.push({type:"thinking_end",contentIndex:slot.contentIndex,content:slot.block.thinking,partial:output}),outputSlots.delete(event.output_index)}else item.type==="message"&&slot?.type==="text"?(slot.block.text=item.content?.map(c=>c.type==="output_text"?c.text:c.refusal).join("")||"",slot.block.textSignature=encodeTextSignatureV1(item.id,item.phase??void 0),stream.push({type:"text_end",contentIndex:slot.contentIndex,content:slot.block.text,partial:output}),outputSlots.delete(event.output_index)):item.type==="function_call"&&slot?.type==="toolCall"&&slot.input.kind==="json"?(item.arguments&&slot.input.arguments.replace(item.arguments),Object.assign(slot.block,slot.input.arguments.finish()),item.namespace!==void 0&&(slot.block.namespace=item.namespace),unfinishedToolCalls.delete(slot.block),stream.push({type:"toolcall_end",contentIndex:slot.contentIndex,toolCall:slot.block,partial:output}),outputSlots.delete(event.output_index)):item.type==="custom_tool_call"&&slot?.type==="toolCall"&&slot.input.kind==="custom"&&(pushToolCallDelta(slot,closeCustomInput(slot.block,slot.input,item.input)),item.namespace!==void 0&&(slot.block.namespace=item.namespace),unfinishedToolCalls.delete(slot.block),stream.push({type:"toolcall_end",contentIndex:slot.contentIndex,toolCall:slot.block,partial:output}),outputSlots.delete(event.output_index))}else if(event.type==="response.completed"||event.type==="response.incomplete")finalizeResponse(event.response);else{if(event.type==="error")throw new Error(`Error Code ${event.code}: ${event.message}`||"Unknown error");if(event.type==="response.failed"){sawTerminalResponseEvent=!0,output.rawStopReason=event.response?.status;let error=event.response?.error,details=event.response?.incomplete_details,msg=error?`${error.code||"unknown"}: ${error.message||"no message"}`:details?.reason?`incomplete: ${details.reason}`:"Unknown error (no error details in response)";throw new Error(msg)}}if(!sawTerminalResponseEvent)throw new Error("OpenAI Responses stream ended before a terminal response event");if(output.stopReason==="toolUse")for(let toolCall of unfinishedToolCalls)throw new Error(`OpenAI Responses stream completed with an unfinished tool call: ${toolCall.name} (${toolCall.id})`)}function customInput(property,initialInput){let buffer={input:"",started:!1,closed:!1};return{kind:"custom",property,buffer,unsent:appendGrammarToolInputJsonDelta(buffer,property,initialInput)??""}}function appendCustomInput(block,input,delta){return sendCustomInput(block,input,appendGrammarToolInputJsonDelta(input.buffer,input.property,delta))}function closeCustomInput(block,input,finalInput){return sendCustomInput(block,input,closeGrammarToolInputJson(input.buffer,input.property,finalInput))}function sendCustomInput(block,input,jsonDelta){if(block.arguments={[input.property]:input.buffer.input},input.unsent==="")return jsonDelta;let sent=input.unsent+(jsonDelta??"");return input.unsent="",sent}function mapStopReason(status,incompleteReason){if(!status)return{stopReason:"stop"};switch(status){case"completed":return{stopReason:"stop"};case"incomplete":return incompleteReason==="max_output_tokens"?{stopReason:"length"}:{stopReason:"error",errorMessage:incompleteReason?`Response incomplete: ${incompleteReason}`:"Response incomplete without a provider reason"};case"failed":case"cancelled":return{stopReason:"error"};case"in_progress":case"queued":return{stopReason:"stop"};default:{let _exhaustive=status;throw new Error(`Unhandled stop reason: ${_exhaustive}`)}}}export{getResponsesToolSupport,convertResponsesMessages,convertResponsesTools,processResponsesStream};
