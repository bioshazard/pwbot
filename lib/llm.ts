import OpenAI from 'openai';

export const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
	baseURL: process.env.OPENAI_API_BASE,
});

export const reply = async ( prompt: any ) => {
	const completion = await client.chat.completions.create({
		model: process.env.OPENAI_API_MODEL || 'gpt-4o',
		messages: [
			...prompt
		],
		// messages: [
		// 	{ role: 'system', content: 'You are a helpful assistant' },
		// 	{ role: 'user', content: input },
		// ],
	});
	return completion.choices[0].message.content
}
