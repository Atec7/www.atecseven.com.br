let currentStep = 0;
let selectedOption = '';
let userData = {};

function sendMessage() {
    const userInput = document.getElementById('userInput').value;
    if (userInput.trim() === '') return;

    const chatBox = document.getElementById('chatBox');

    // Adiciona a mensagem do usuário
    const userMessage = document.createElement('div');
    userMessage.className = 'message user';
    userMessage.textContent = userInput;
    chatBox.appendChild(userMessage);

    // Limpa o campo de entrada
    document.getElementById('userInput').value = '';

    // Simula um indicador de digitando do bot
    const typingIndicator = document.createElement('div');
    typingIndicator.className = 'message bot typing-indicator';
    typingIndicator.textContent = 'Digitando...';
    chatBox.appendChild(typingIndicator);

    // Mantém a rolagem no final
    chatBox.scrollTop = chatBox.scrollHeight;

    // Responde após 2 segundos
    setTimeout(() => {
        chatBox.removeChild(typingIndicator); // Remove o indicador de digitando

        // Simula uma resposta do bot com base na etapa do atendimento
        const botMessage = document.createElement('div');
        botMessage.className = 'message bot';

        if (currentStep === 0) {
            botMessage.textContent = 'Oi! Como posso ajudar você hoje? Por favor, selecione uma opção:\n1. Suporte Técnico\n2. Comercial\n3. Financeiro\n4. Outro';
            currentStep++;
        } else if (currentStep === 1) {
            selectedOption = userInput.trim();
            switch (selectedOption) {
                case '1':
                    botMessage.textContent = 'Você escolheu Suporte Técnico. Por favor, informe seu nome completo.';
                    currentStep = 10; // Suporte Técnico
                    break;
                case '2':
                    botMessage.textContent = 'Você escolheu Comercial. Por favor, informe seu nome completo.';
                    currentStep = 20; // Comercial
                    break;
                case '3':
                    botMessage.textContent = 'Você escolheu Financeiro. Por favor, informe seu nome completo.';
                    currentStep = 31; // Financeiro
                    break;
                case '4':
                    botMessage.textContent = 'Você escolheu Outro. Por favor, informe seu nome completo e sua solicitação.';
                    currentStep = 40; // Outro
                    break;
                default:
                    botMessage.textContent = 'Opção inválida. Por favor, selecione uma opção:\n1. Suporte Técnico\n2. Comercial\n3. Financeiro\n4. Outro';
                    currentStep = 1;
                    break;
            }
        } else if (currentStep === 10) {
            if (!userData.name) {
                userData.name = userInput.trim();
                botMessage.textContent = 'Obrigado. Por favor, descreva seu problema.';
            } else {
                userData.problem = userInput.trim();
                botMessage.textContent = 'Perfeito! Estamos encaminhando suas informações para um de nossos atendentes. Você será contatado em breve.';
                currentStep = 0;

                // Envia a mensagem para o número especificado
                const message = `Suporte Técnico:\nNome: ${userData.name}\nProblema: ${userData.problem}`;
                sendToWhatsApp(message);
            }
        } else if (currentStep === 20) {
            if (!userData.name) {
                userData.name = userInput.trim();
                botMessage.textContent = 'Obrigado. Por favor, informe o nome da sua empresa ou negócio.';
            } else if (!userData.company) {
                userData.company = userInput.trim();
                botMessage.textContent = 'Ótimo! Por favor, informe o serviço de seu interesse.';
            } else {
                userData.service = userInput.trim();
                botMessage.textContent = 'Perfeito! Estamos encaminhando suas informações para o nosso departamento comercial. Você será contatado em breve.';
                currentStep = 0;

                // Envia a mensagem para o número especificado
                const message = `Comercial:\nNome: ${userData.name}\nEmpresa: ${userData.company}\nServiço de Interesse: ${userData.service}`;
                sendToWhatsApp(message);
            }
        } else if (currentStep === 31) {
            if (!userData.name) {
                userData.name = userInput.trim();
                botMessage.textContent = 'Obrigado. Por favor, descreva sua situação financeira.';
            } else if (!userData.financialSituation) {
                userData.financialSituation = userInput.trim();
                botMessage.textContent = 'Ótimo! Por favor, informe a forma de pagamento.';
            } else {
                userData.paymentMethod = userInput.trim();
                botMessage.textContent = 'Perfeito! Estamos encaminhando suas informações para o nosso departamento financeiro. Você será contatado em breve.';
                currentStep = 0;

                // Envia a mensagem para o número especificado
                const message = `Financeiro:\nNome: ${userData.name}\nSituação Financeira: ${userData.financialSituation}\nForma de Pagamento: ${userData.paymentMethod}`;
                sendToWhatsApp(message);
            }
        } else if (currentStep === 40) {
            if (!userData.name) {
                userData.name = userInput.trim();
                botMessage.textContent = 'Obrigado. Por favor, descreva sua solicitação.';
            } else {
                userData.request = userInput.trim();
                botMessage.textContent = 'Perfeito! Estamos encaminhando suas informações para o nosso atendimento. Você será contatado em breve.';
                currentStep = 0;

                // Envia a mensagem para o número especificado
                const message = `Outro:\nNome: ${userData.name}\nSolicitação: ${userData.request}`;
                sendToWhatsApp(message);
            }
        }

        chatBox.appendChild(botMessage);
        chatBox.scrollTop = chatBox.scrollHeight;
    }, 2000); // Responde após 2 segundos
}

function sendToWhatsApp(message) {
    const encodedMessage = encodeURIComponent(message);
    const whatsappUrl = `https://wa.me/5564992952748?text=${encodedMessage}`;
    setTimeout(() => {
        window.open(whatsappUrl, '_blank');
    }, 2000); // Aguarda 2 segundos antes de abrir o WhatsApp
}