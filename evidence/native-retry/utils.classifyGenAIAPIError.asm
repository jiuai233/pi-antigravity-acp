google3/third_party/jetski/cortex/utils/utils.classifyGenAIAPIError 0x14172ce40 size=1600
0x14172ce40 lea r12, [rsp - 0x78]
0x14172ce45 cmp r12, qword ptr [r14 + 0x10]
0x14172ce49 jbe 0x14172d43c
0x14172ce4f push rbp
0x14172ce50 mov rbp, rsp
0x14172ce53 sub rsp, 0xf0
0x14172ce5a mov qword ptr [rsp + 0x140], rax
0x14172ce62 mov qword ptr [rsp + 0x148], rbx
0x14172ce6a lea rdx, [rsp + 0x58]
0x14172ce6f movups xmmword ptr [rdx], xmm15
0x14172ce73 movups xmmword ptr [rdx + 0x10], xmm15
0x14172ce78 movups xmmword ptr [rdx + 0x20], xmm15
0x14172ce7d mov r9, qword ptr [rsp + 0x128]
0x14172ce85 mov qword ptr [rsp + 0xe8], r9
0x14172ce8d mov r10, qword ptr [rsp + 0x130]
0x14172ce95 mov qword ptr [rsp + 0x48], r10
0x14172ce9a xor ecx, ecx
0x14172ce9c jmp 0x14172ceb3
0x14172ce9e mov rcx, qword ptr [rsp + 0x40]
0x14172cea3 inc rcx
0x14172cea6 mov r9, qword ptr [rsp + 0xe8]
0x14172ceae mov r10, qword ptr [rsp + 0x48]
0x14172ceb3 cmp rcx, r10
0x14172ceb6 jge 0x14172cf07
0x14172ceb8 mov qword ptr [rsp + 0x40], rcx
0x14172cebd mov rbx, qword ptr [r9 + rcx*8]
0x14172cec1 lea rax, [rip + 0x9269428] ; b'\x08\x00\x00\x00\x00\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00\x00\xa4j^\xc7"\x08\x08\x15\x00\x00\x00\x00\x00\x00\x00\x00H\x89\xc5D\x01\x00\x00\x00\xf7X{\x00 \xde*\x00\x00\xa4\xcaJ\x01\x00\x00\x00\xf0=\xd6J\x01\x00\x00\x00 +\nK\x01\x00\x00\x00\xa0\xb3\x80K\x01\x00\x00\x00'
0x14172cec8 lea rcx, [rip + 0x29ecbe6] ; b'reason.pbtxt30-90dvet.tsJJ_GitPragma<head>randomstdoutstderriTerm2\r%s %s/QueryRE'
0x14172cecf mov edi, 6
0x14172ced4 call 0x140011420 ; runtime.mapaccess1_faststr
0x14172ced9 lea rdx, [rip + 0x957d520] ; b'\x10\x00\x00\x00\x00\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00\x00\xb82\x87\xf8\x07\x08\x08\x18\xb0\xb3\x80K\x01\x00\x00\x00H\x89\xc5D\x01\x00\x00\x00\xd5\xe3j\x00\x90\xf4=\x00\x00\x00\x00\x00\x00\x00\x00\x00\x10\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'
0x14172cee0 cmp qword ptr [rax], rdx
0x14172cee3 jne 0x14172cef2
0x14172cee5 mov rdx, qword ptr [rax + 8]
0x14172cee9 mov rax, qword ptr [rdx]
0x14172ceec mov rdx, qword ptr [rdx + 8]
0x14172cef0 jmp 0x14172cefc
0x14172cef2 mov edx, 0
0x14172cef7 mov eax, 0
0x14172cefc jne 0x14172ce9e
0x14172cefe nop 
0x14172cf00 test rdx, rdx
0x14172cf03 je 0x14172ce9e
0x14172cf05 jmp 0x14172cf0b
0x14172cf07 xor edx, edx
0x14172cf09 xor eax, eax
0x14172cf0b cmp rdx, 0xf
0x14172cf0f jne 0x14172cf55
0x14172cf11 movabs rdx, 0x58455f41544f5551
0x14172cf1b nop dword ptr [rax + rax]
0x14172cf20 cmp qword ptr [rax], rdx
0x14172cf23 jne 0x14172d15e
0x14172cf29 cmp dword ptr [rax + 8], 0x53554148
0x14172cf30 jne 0x14172d15e
0x14172cf36 cmp word ptr [rax + 0xc], 0x4554
0x14172cf3c nop dword ptr [rax]
0x14172cf40 jne 0x14172d15e
0x14172cf46 cmp byte ptr [rax + 0xe], 0x44
0x14172cf4a je 0x14172d136
0x14172cf50 jmp 0x14172d15e
0x14172cf55 cmp rdx, 0x13
0x14172cf59 je 0x14172cf8d
0x14172cf5b nop dword ptr [rax + rax]
0x14172cf60 cmp rdx, 0x18
0x14172cf64 jne 0x14172d15e
0x14172cf6a lea rbx, [rip + 0x2b72f34] ; b'MODEL_CAPACITY_EXHAUSTEDPREFILL_QUEUE_OVERLOADEDOverloaded prefill queueTerminal'
0x14172cf71 mov ecx, 0x18
0x14172cf76 call 0x140013320 ; runtime.memequal
0x14172cf7b nop dword ptr [rax + rax]
0x14172cf80 test al, al
0x14172cf82 jne 0x14172d136
0x14172cf88 jmp 0x14172d15e
0x14172cf8d mov qword ptr [rsp + 0x50], rax
0x14172cf92 lea rbx, [rip + 0x2b166db] ; b'RATE_LIMIT_EXCEEDEDno codec configuredfailed_preconditionmarshal message: %wINAD'
0x14172cf99 mov ecx, 0x13
0x14172cf9e nop 
0x14172cfa0 call 0x140013320 ; runtime.memequal
0x14172cfa5 test al, al
0x14172cfa7 je 0x14172d11c
0x14172cfad lea rdx, [rsp + 0x88]
0x14172cfb5 movups xmmword ptr [rdx], xmm15
0x14172cfb9 movups xmmword ptr [rdx + 0x10], xmm15
0x14172cfbe movups xmmword ptr [rdx + 0x20], xmm15
0x14172cfc3 lea rdx, [rip + 0x2ca6f00] ; b'The model API is currently overloaded and may experience intermittent errors./go'
0x14172cfca mov qword ptr [rsp + 0x90], rdx
0x14172cfd2 mov qword ptr [rsp + 0x98], 0x4d
0x14172cfde mov byte ptr [rsp + 0x88], 1
0x14172cfe6 mov rax, qword ptr [rsp + 0x100]
0x14172cfee mov rbx, qword ptr [rsp + 0x108]
0x14172cff6 mov rcx, qword ptr [rsp + 0x110]
0x14172cffe mov rdi, qword ptr [rsp + 0x118]
0x14172d006 mov rsi, qword ptr [rsp + 0x120]
0x14172d00e mov r8, qword ptr [rsp + 0x128]
0x14172d016 mov r9, qword ptr [rsp + 0x130]
0x14172d01e mov r10, qword ptr [rsp + 0x138]
0x14172d026 call 0x14172cb20 ; google3/third_party/jetski/cortex/utils/utils.extractRetryDelayFromGenAIError
0x14172d02b test bl, bl
0x14172d02d je 0x14172d0c1
0x14172d033 mov rdx, rax
0x14172d036 sar rax, 0x3f
0x14172d03a mov rcx, rax
0x14172d03d movabs rax, 0x44b82fa09b5a52cc
0x14172d047 mov rbx, rdx
0x14172d04a imul rdx
0x14172d04d sar rdx, 0x1c
0x14172d051 sub rdx, rcx
0x14172d054 imul r9, rdx, 0x3b9aca00
0x14172d05b mov r10, rbx
0x14172d05e sub rbx, r9
0x14172d061 xorps xmm0, xmm0
0x14172d064 cvtsi2sd xmm0, rdx
0x14172d069 xorps xmm1, xmm1
0x14172d06c cvtsi2sd xmm1, rbx
0x14172d071 movsd xmm2, qword ptr [rip + 0x353f427]
0x14172d079 divsd xmm1, xmm2
0x14172d07d addsd xmm1, xmm0
0x14172d081 movsd xmm0, qword ptr [rip + 0x353faa7]
0x14172d089 ucomisd xmm1, xmm0
0x14172d08d ja 0x14172d099
0x14172d08f mov qword ptr [rsp + 0xa0], r10
0x14172d097 jmp 0x14172d0c1
0x14172d099 lea rdx, [rsp + 0x58]
0x14172d09e movups xmmword ptr [rdx], xmm15
0x14172d0a2 movups xmmword ptr [rdx + 0x10], xmm15
0x14172d0a7 movups xmmword ptr [rdx + 0x20], xmm15
0x14172d0ac mov rbx, qword ptr [rsp + 0x60]
0x14172d0b1 mov rsi, qword ptr [rsp + 0x78]
0x14172d0b6 xor eax, eax
0x14172d0b8 xor ecx, ecx
0x14172d0ba xor edi, edi
0x14172d0bc mov r8d, ecx
0x14172d0bf leave 
0x14172d0c0 ret 
0x14172d0c1 movzx eax, byte ptr [rsp + 0x88]
0x14172d0c9 mov rbx, qword ptr [rsp + 0x90]
0x14172d0d1 mov rcx, qword ptr [rsp + 0x98]
0x14172d0d9 mov rdi, qword ptr [rsp + 0xa0]
0x14172d0e1 mov rsi, qword ptr [rsp + 0xa8]
0x14172d0e9 mov r8, qword ptr [rsp + 0xb0]
0x14172d0f1 lea rdx, [rsp + 0x58]
0x14172d0f6 lea r9, [rsp + 0x88]
0x14172d0fe movups xmm14, xmmword ptr [r9]
0x14172d102 movups xmmword ptr [rdx], xmm14
0x14172d106 movups xmm14, xmmword ptr [r9 + 0x10]
0x14172d10b movups xmmword ptr [rdx + 0x10], xmm14
0x14172d110 movups xmm14, xmmword ptr [r9 + 0x20]
0x14172d115 movups xmmword ptr [rdx + 0x20], xmm14
0x14172d11a leave 
0x14172d11b ret 
0x14172d11c mov rax, qword ptr [rsp + 0x50]
0x14172d121 lea rbx, [rip + 0x2b1537c] ; b'VALIDATION_REQUIREDaicode_error_reasonX-Aicode-Request-IdbattleModeOverridesregi'
0x14172d128 mov ecx, 0x13
0x14172d12d call 0x140013320 ; runtime.memequal
0x14172d132 test al, al
0x14172d134 je 0x14172d15e
0x14172d136 lea rdx, [rsp + 0x58]
0x14172d13b movups xmmword ptr [rdx], xmm15
0x14172d13f movups xmmword ptr [rdx + 0x10], xmm15
0x14172d144 movups xmmword ptr [rdx + 0x20], xmm15
0x14172d149 mov rbx, qword ptr [rsp + 0x60]
0x14172d14e mov rsi, qword ptr [rsp + 0x78]
0x14172d153 xor eax, eax
0x14172d155 xor ecx, ecx
0x14172d157 xor edi, edi
0x14172d159 mov r8d, ecx
0x14172d15c leave 
0x14172d15d ret 
0x14172d15e cmp qword ptr [rsp + 0x100], 0x1ad
0x14172d16a jne 0x14172d18d
0x14172d16c mov rax, qword ptr [rsp + 0x108]
0x14172d174 mov rbx, qword ptr [rsp + 0x110]
0x14172d17c nop dword ptr [rax]
0x14172d180 call 0x14172cc20 ; google3/third_party/jetski/cortex/utils/utils.isHardQuotaExhaustedMessage
0x14172d185 test al, al
0x14172d187 jne 0x14172d414
0x14172d18d mov rax, qword ptr [rsp + 0x140]
0x14172d195 mov rbx, qword ptr [rsp + 0x148]
0x14172d19d nop dword ptr [rax]
0x14172d1a0 call 0x14172cd20 ; google3/third_party/jetski/cortex/utils/utils.isMidStreamError
0x14172d1a5 test al, al
0x14172d1a7 jne 0x14172d3d1
0x14172d1ad mov rdx, qword ptr [rsp + 0x100]
0x14172d1b5 cmp rdx, 0x1f4
0x14172d1bc jg 0x14172d202
0x14172d1be nop 
0x14172d1c0 cmp rdx, 0x198
0x14172d1c7 je 0x14172d249
0x14172d1cd cmp rdx, 0x1ad
0x14172d1d4 jne 0x14172d1e9
0x14172d1d6 mov eax, 1
0x14172d1db mov ecx, 0x4d
0x14172d1e0 lea rdx, [rip + 0x2ca6ce3] ; b'The model API is currently overloaded and may experience intermittent errors./go'
0x14172d1e7 jmp 0x14172d262
0x14172d1e9 cmp rdx, 0x1f4
0x14172d1f0 jne 0x14172d25c
0x14172d1f2 xor eax, eax
0x14172d1f4 mov ecx, 0x28
0x14172d1f9 lea rdx, [rip + 0x2c0f0dd] ; b'The model encountered an internal error.type.googleapis.com/google.rpc.RetryInfo'
0x14172d200 jmp 0x14172d262
0x14172d202 cmp rdx, 0x1f6
0x14172d209 jne 0x14172d220
0x14172d20b mov eax, 1
0x14172d210 mov ecx, 0x23
0x14172d215 lea rdx, [rip + 0x2bea9b2] ; b'The model is currently unreachable.incomplete envelope: unexpected EOFfailed to '
0x14172d21c jmp 0x14172d262
0x14172d21e nop 
0x14172d220 cmp rdx, 0x1f7
0x14172d227 jne 0x14172d240
0x14172d229 mov eax, 1
0x14172d22e mov ecx, 0x23
0x14172d233 lea rdx, [rip + 0x2bea994] ; b'The model is currently unreachable.incomplete envelope: unexpected EOFfailed to '
0x14172d23a jmp 0x14172d262
0x14172d23c nop dword ptr [rax]
0x14172d240 cmp rdx, 0x1f8
0x14172d247 jne 0x14172d25c
0x14172d249 mov eax, 1
0x14172d24e mov ecx, 0x8a
0x14172d253 lea rdx, [rip + 0x2cda2ca] ; b"Shorten your output to avoid hitting the context deadline timeout again. If you'"
0x14172d25a jmp 0x14172d262
0x14172d25c xor eax, eax
0x14172d25e xor ecx, ecx
0x14172d260 xor edx, edx
0x14172d262 lea r11, [rsp + 0xb8]
0x14172d26a movups xmmword ptr [r11], xmm15
0x14172d26e movups xmmword ptr [r11 + 0x10], xmm15
0x14172d273 movups xmmword ptr [r11 + 0x20], xmm15
0x14172d278 mov qword ptr [rsp + 0xc0], rdx
0x14172d280 mov qword ptr [rsp + 0xc8], rcx
0x14172d288 mov byte ptr [rsp + 0xb8], al
0x14172d28f test al, al
0x14172d291 je 0x14172d37e
0x14172d297 mov rax, qword ptr [rsp + 0x100]
0x14172d29f mov rbx, qword ptr [rsp + 0x108]
0x14172d2a7 mov rcx, qword ptr [rsp + 0x110]
0x14172d2af mov rdi, qword ptr [rsp + 0x118]
0x14172d2b7 mov rsi, qword ptr [rsp + 0x120]
0x14172d2bf mov r8, qword ptr [rsp + 0x128]
0x14172d2c7 mov r9, qword ptr [rsp + 0x130]
0x14172d2cf mov r10, qword ptr [rsp + 0x138]
0x14172d2d7 call 0x14172cb20 ; google3/third_party/jetski/cortex/utils/utils.extractRetryDelayFromGenAIError
0x14172d2dc nop dword ptr [rax]
0x14172d2e0 test bl, bl
0x14172d2e2 je 0x14172d376
0x14172d2e8 mov rdx, rax
0x14172d2eb sar rax, 0x3f
0x14172d2ef mov rcx, rax
0x14172d2f2 movabs rax, 0x44b82fa09b5a52cc
0x14172d2fc mov rbx, rdx
0x14172d2ff imul rdx
0x14172d302 sar rdx, 0x1c
0x14172d306 sub rdx, rcx
0x14172d309 imul r9, rdx, 0x3b9aca00
0x14172d310 mov r10, rbx
0x14172d313 sub rbx, r9
0x14172d316 xorps xmm0, xmm0
0x14172d319 cvtsi2sd xmm0, rdx
0x14172d31e xorps xmm1, xmm1
0x14172d321 cvtsi2sd xmm1, rbx
0x14172d326 movsd xmm2, qword ptr [rip + 0x353f172]
0x14172d32e divsd xmm1, xmm2
0x14172d332 addsd xmm1, xmm0
0x14172d336 movsd xmm0, qword ptr [rip + 0x353f7f2]
0x14172d33e ucomisd xmm1, xmm0
0x14172d342 ja 0x14172d34e
0x14172d344 mov qword ptr [rsp + 0xd0], r10
0x14172d34c jmp 0x14172d376
0x14172d34e lea rdx, [rsp + 0x58]
0x14172d353 movups xmmword ptr [rdx], xmm15
0x14172d357 movups xmmword ptr [rdx + 0x10], xmm15
0x14172d35c movups xmmword ptr [rdx + 0x20], xmm15
0x14172d361 mov rbx, qword ptr [rsp + 0x60]
0x14172d366 mov rsi, qword ptr [rsp + 0x78]
0x14172d36b xor eax, eax
0x14172d36d xor ecx, ecx
0x14172d36f xor edi, edi
0x14172d371 mov r8d, ecx
0x14172d374 leave 
0x14172d375 ret 
0x14172d376 lea r11, [rsp + 0xb8]
0x14172d37e movzx eax, byte ptr [rsp + 0xb8]
0x14172d386 mov rbx, qword ptr [rsp + 0xc0]
0x14172d38e mov rcx, qword ptr [rsp + 0xc8]
0x14172d396 mov rdi, qword ptr [rsp + 0xd0]
0x14172d39e mov rsi, qword ptr [rsp + 0xd8]
0x14172d3a6 mov r8, qword ptr [rsp + 0xe0]
0x14172d3ae lea rdx, [rsp + 0x58]
0x14172d3b3 movups xmm14, xmmword ptr [r11]
0x14172d3b7 movups xmmword ptr [rdx], xmm14
0x14172d3bb movups xmm14, xmmword ptr [r11 + 0x10]
0x14172d3c0 movups xmmword ptr [rdx + 0x10], xmm14
0x14172d3c5 movups xmm14, xmmword ptr [r11 + 0x20]
0x14172d3ca movups xmmword ptr [rdx + 0x20], xmm14
0x14172d3cf leave 
0x14172d3d0 ret 
0x14172d3d1 lea rdx, [rsp + 0x58]
0x14172d3d6 movups xmmword ptr [rdx], xmm15
0x14172d3da movups xmmword ptr [rdx + 0x10], xmm15
0x14172d3df movups xmmword ptr [rdx + 0x20], xmm15
0x14172d3e4 mov rsi, qword ptr [rsp + 0x78]
0x14172d3e9 lea rbx, [rip + 0x2c9e329] ; b'The stream was interrupted. Please continue the task you were working on.The use'
0x14172d3f0 mov qword ptr [rsp + 0x60], rbx
0x14172d3f5 mov qword ptr [rsp + 0x68], 0x49
0x14172d3fe mov byte ptr [rsp + 0x58], 1
0x14172d403 mov eax, 1
0x14172d408 mov ecx, 0x49
0x14172d40d xor edi, edi
0x14172d40f xor r8d, r8d
0x14172d412 leave 
0x14172d413 ret 
0x14172d414 lea rdx, [rsp + 0x58]
0x14172d419 movups xmmword ptr [rdx], xmm15
0x14172d41d movups xmmword ptr [rdx + 0x10], xmm15
0x14172d422 movups xmmword ptr [rdx + 0x20], xmm15
0x14172d427 mov rbx, qword ptr [rsp + 0x60]
0x14172d42c mov rsi, qword ptr [rsp + 0x78]
0x14172d431 xor eax, eax
0x14172d433 xor ecx, ecx
0x14172d435 xor edi, edi
0x14172d437 mov r8d, ecx
0x14172d43a leave 
0x14172d43b ret 
0x14172d43c mov qword ptr [rsp + 0x48], rax
0x14172d441 mov qword ptr [rsp + 0x50], rbx
0x14172d446 mov byte ptr [rsp + 0x58], cl
0x14172d44a call 0x1400965c0 ; runtime.morestack_noctxt
0x14172d44f mov rax, qword ptr [rsp + 0x48]
0x14172d454 mov rbx, qword ptr [rsp + 0x50]
0x14172d459 movzx ecx, byte ptr [rsp + 0x58]
0x14172d45e nop 
0x14172d460 jmp 0x14172ce40
0x14172d465 int3 
0x14172d466 int3 
0x14172d467 int3 
0x14172d468 int3 
0x14172d469 int3 
0x14172d46a int3 
0x14172d46b int3 
0x14172d46c int3 
0x14172d46d int3 
0x14172d46e int3 
0x14172d46f int3 
0x14172d470 int3 
0x14172d471 int3 
0x14172d472 int3 
0x14172d473 int3 
0x14172d474 int3 
0x14172d475 int3 
0x14172d476 int3 
0x14172d477 int3 
0x14172d478 int3 
0x14172d479 int3 
0x14172d47a int3 
0x14172d47b int3 
0x14172d47c int3 
0x14172d47d int3 
0x14172d47e int3 
0x14172d47f int3 
