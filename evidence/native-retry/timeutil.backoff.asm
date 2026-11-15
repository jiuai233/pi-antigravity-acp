google3/util/time/go/timeutil.backoff 0x14168f9c0 size=256
0x14168f9c0 cmp rsp, qword ptr [r14 + 0x10]
0x14168f9c4 jbe 0x14168fa6e
0x14168f9ca push rbp
0x14168f9cb mov rbp, rsp
0x14168f9ce sub rsp, 0x18
0x14168f9d2 mov qword ptr [rsp + 0x38], rax
0x14168f9d7 xorps xmm2, xmm2
0x14168f9da cvtsi2sd xmm2, rax
0x14168f9df xorps xmm3, xmm3
0x14168f9e2 cvtsi2sd xmm3, rbx
0x14168f9e7 jmp 0x14168f9f0
0x14168f9e9 mulsd xmm2, xmm0
0x14168f9ed dec rcx
0x14168f9f0 ucomisd xmm3, xmm2
0x14168f9f4 jbe 0x14168f9fb
0x14168f9f6 test rcx, rcx
0x14168f9f9 jg 0x14168f9e9
0x14168f9fb minsd xmm3, xmm2
0x14168f9ff movsd qword ptr [rsp + 8], xmm3
0x14168fa05 mulsd xmm1, xmm3
0x14168fa09 movsd qword ptr [rsp + 0x10], xmm1
0x14168fa0f mov rcx, qword ptr [rip + 0xc14d2f2]
0x14168fa16 mov rdx, qword ptr [rcx]
0x14168fa19 mov rax, qword ptr [rcx + 8]
0x14168fa1d mov rcx, qword ptr [rdx + 0x18]
0x14168fa21 call rcx
0x14168fa23 movabs rcx, 0x1fffffffffffff
0x14168fa2d and rax, rcx
0x14168fa30 xorps xmm0, xmm0
0x14168fa33 cvtsi2sd xmm0, rax
0x14168fa38 movsd xmm1, qword ptr [rip + 0x35dce40]
0x14168fa40 mulsd xmm1, xmm0
0x14168fa44 movsd xmm0, qword ptr [rsp + 0x10]
0x14168fa4a mulsd xmm0, xmm1
0x14168fa4e movsd xmm1, qword ptr [rsp + 8]
0x14168fa54 subsd xmm1, xmm0
0x14168fa58 cvttsd2si rax, xmm1
0x14168fa5d mov rcx, qword ptr [rsp + 0x38]
0x14168fa62 cmp rcx, rax
0x14168fa65 jle 0x14168fa6c
0x14168fa67 mov rax, rcx
0x14168fa6a leave 
0x14168fa6b ret 
0x14168fa6c leave 
0x14168fa6d ret 
0x14168fa6e movsd qword ptr [rsp + 8], xmm0
0x14168fa74 movsd qword ptr [rsp + 0x10], xmm1
0x14168fa7a mov qword ptr [rsp + 0x18], rax
0x14168fa7f mov qword ptr [rsp + 0x20], rbx
0x14168fa84 mov qword ptr [rsp + 0x28], rcx
0x14168fa89 call 0x1400965c0 ; runtime.morestack_noctxt
0x14168fa8e movsd xmm0, qword ptr [rsp + 8]
0x14168fa94 movsd xmm1, qword ptr [rsp + 0x10]
0x14168fa9a mov rax, qword ptr [rsp + 0x18]
0x14168fa9f mov rbx, qword ptr [rsp + 0x20]
0x14168faa4 mov rcx, qword ptr [rsp + 0x28]
0x14168faa9 jmp 0x14168f9c0
0x14168faae int3 
0x14168faaf int3 
0x14168fab0 int3 
0x14168fab1 int3 
0x14168fab2 int3 
0x14168fab3 int3 
0x14168fab4 int3 
0x14168fab5 int3 
0x14168fab6 int3 
0x14168fab7 int3 
0x14168fab8 int3 
0x14168fab9 int3 
0x14168faba int3 
0x14168fabb int3 
0x14168fabc int3 
0x14168fabd int3 
0x14168fabe int3 
0x14168fabf int3 
