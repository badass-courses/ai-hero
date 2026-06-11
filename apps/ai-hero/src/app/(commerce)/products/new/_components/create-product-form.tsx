import { NewProduct, NewProductSchema } from '@/lib/products'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'

import { Product } from '@coursebuilder/core/schemas'
import {
	Button,
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@coursebuilder/ui'

const DEFAULT_ARCHIVE_AVAILABLE_AFTER_DAYS = 15
const DEFAULT_ARCHIVE_ACCESS_DURATION_DAYS = 365

export function CreateProductForm({
	onCreate,
	createProduct,
}: {
	onCreate: (resource: Product) => Promise<void>
	createProduct: (values: NewProduct) => Promise<Product | null>
}) {
	const form = useForm<NewProduct>({
		mode: 'onChange',
		resolver: zodResolver(NewProductSchema),
		defaultValues: {
			name: '',
			quantityAvailable: -1,
			price: 0,
			type: 'self-paced',
			availableAfterDays: DEFAULT_ARCHIVE_AVAILABLE_AFTER_DAYS,
			accessDurationDays: DEFAULT_ARCHIVE_ACCESS_DURATION_DAYS,
		},
	})

	const productType = form.watch('type')
	const isCohortArchive = productType === 'cohort-archive'

	const internalOnSubmit = async (values: NewProduct) => {
		const resource = await createProduct({
			name: values.name,
			quantityAvailable: values.quantityAvailable,
			price: values.price,
			type: values.type,
			...(isCohortArchive && {
				availableAfterDays: values.availableAfterDays,
				accessDurationDays: values.accessDurationDays,
			}),
		})
		if (resource) {
			form.reset({
				name: '',
				quantityAvailable: -1,
				price: 0,
				type: 'self-paced',
				availableAfterDays: DEFAULT_ARCHIVE_AVAILABLE_AFTER_DAYS,
				accessDurationDays: DEFAULT_ARCHIVE_ACCESS_DURATION_DAYS,
			})
			await onCreate(resource)
		}
	}

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(internalOnSubmit)}
				className="bg-muted rounded p-3"
			>
				<FormField
					control={form.control}
					name="name"
					render={({ field }) => {
						return (
							<FormItem>
								<FormLabel className="text-lg font-bold">Name</FormLabel>
								<FormDescription className="mt-2 text-sm">
									A name should summarize the product and explain what it is
									about succinctly.
								</FormDescription>
								<FormControl>
									<Input {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)
					}}
				/>
				<FormField
					control={form.control}
					name="type"
					render={({ field }) => {
						return (
							<FormItem>
								<FormLabel className="text-lg font-bold">Type</FormLabel>
								<FormDescription className="mt-2 text-sm">
									Select the product type used for checkout and downstream
									behavior.
								</FormDescription>
								<Select
									onValueChange={field.onChange}
									value={field.value ?? ''}
								>
									<FormControl>
										<SelectTrigger className="w-full">
											<SelectValue placeholder="Select product type..." />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										<SelectItem value="live">Live</SelectItem>
										<SelectItem value="self-paced">Self-paced</SelectItem>
										<SelectItem value="membership">Membership</SelectItem>
										<SelectItem value="cohort">Cohort</SelectItem>
										<SelectItem value="cohort-archive">
											Cohort Archive
										</SelectItem>
									</SelectContent>
								</Select>
								<FormMessage />
							</FormItem>
						)
					}}
				/>
				{isCohortArchive && (
					<>
						<FormField
							control={form.control}
							name="availableAfterDays"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel className="text-lg font-bold">
											Available After Days
										</FormLabel>
										<FormDescription className="mt-2 text-sm">
											How many days after a cohort ends before it joins the
											archive.
										</FormDescription>
										<FormControl>
											<Input
												type="number"
												min={1}
												value={field.value ?? ''}
												onChange={(event) => {
													const value = event.target.value
													field.onChange(
														value === '' ? undefined : Number(value),
													)
												}}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)
							}}
						/>
						<FormField
							control={form.control}
							name="accessDurationDays"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel className="text-lg font-bold">
											Access Duration Days
										</FormLabel>
										<FormDescription className="mt-2 text-sm">
											How long archive access should last after purchase.
										</FormDescription>
										<FormControl>
											<Input
												type="number"
												min={1}
												value={field.value ?? ''}
												onChange={(event) => {
													const value = event.target.value
													field.onChange(
														value === '' ? undefined : Number(value),
													)
												}}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)
							}}
						/>
					</>
				)}
				<FormField
					control={form.control}
					name="quantityAvailable"
					render={({ field }) => {
						return (
							<FormItem>
								<FormLabel className="text-lg font-bold">
									Quantity Available
								</FormLabel>
								<FormDescription className="mt-2 text-sm">
									The number of items that can be purchased at one time.
								</FormDescription>
								<FormControl>
									<Input type="number" min={-1} {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)
					}}
				/>
				<FormField
					control={form.control}
					name="price"
					render={({ field }) => {
						return (
							<FormItem>
								<FormLabel className="text-lg font-bold">Price</FormLabel>
								<FormDescription className="mt-2 text-sm">
									The price of the product in USD.
								</FormDescription>
								<FormControl>
									<Input type="number" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)
					}}
				/>
				<Button
					type="submit"
					className="mt-2"
					variant="default"
					disabled={
						(form.formState.isDirty && !form.formState.isValid) ||
						form.formState.isSubmitting
					}
				>
					Create New Product
				</Button>
			</form>
		</Form>
	)
}
