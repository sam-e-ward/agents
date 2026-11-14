export class CloudError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "CloudError";
		this.status = status;
	}
}

export function validate<T>(parse: () => T): T {
	try {
		return parse();
	} catch {
		throw new CloudError(400, "Invalid request");
	}
}
