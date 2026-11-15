google3/third_party/jetski/cortex/utils/utils.ModelAPIBackoff 0x1417355e0 size=128
0x1417355e0 nop 
0x1417355e1 test rax, rax
0x1417355e4 je 0x1417355eb
0x1417355e6 mov ecx, dword ptr [rax + 0x10]
0x1417355e9 jmp 0x1417355f0
0x1417355eb mov ecx, 0
0x1417355f0 je 0x141735602
0x1417355f2 mov rdx, qword ptr [rax + 0x30]
0x1417355f6 test rdx, rdx
0x1417355f9 je 0x141735602
0x1417355fb mov rdx, qword ptr [rdx]
0x1417355fe nop 
0x141735600 jmp 0x141735604
0x141735602 xor edx, edx
0x141735604 test rdx, rdx
0x141735607 jg 0x141735618
0x141735609 test rax, rax
0x14173560c movabs rbx, 0x37e11d6000
0x141735616 jmp 0x141735635
0x141735618 test rax, rax
0x14173561b je 0x141735622
0x14173561d mov esi, dword ptr [rax + 0x10]
0x141735620 jmp 0x141735624
0x141735622 xor esi, esi
0x141735624 cmp rdx, rsi
0x141735627 cmovl rdx, rsi
0x14173562b imul rbx, rdx, 0xf4240
0x141735632 test rax, rax
0x141735635 je 0x14173563e
0x141735637 movsd xmm0, qword ptr [rax + 0x18]
0x14173563c jmp 0x141735641
0x14173563e xorps xmm0, xmm0
0x141735641 je 0x141735652
0x141735643 mov rdx, qword ptr [rax + 0x28]
0x141735647 test rdx, rdx
0x14173564a je 0x141735652
0x14173564c movsd xmm1, qword ptr [rdx]
0x141735650 jmp 0x141735655
0x141735652 xorps xmm1, xmm1
0x141735655 imul rax, rcx, 0xf4240
0x14173565c ret 
0x14173565d int3 
0x14173565e int3 
0x14173565f int3 
